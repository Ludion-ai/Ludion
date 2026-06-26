/*
 * Pages Function: demo-execution instrumentation sink (instrumentation spec).
 *
 * Receives the small POST beacons emitted by src/track.ts and writes one data
 * point per event to Cloudflare Analytics Engine. This is the ONLY server-side
 * piece of the instrumentation. It is deliberately minimal and fail-soft.
 *
 * Routing: this static `api/track.ts` takes precedence over the `api/[[path]].ts`
 * catch-all (which forwards to the auth-gated workspace handler), so demo events
 * are NOT subjected to the session check — they are anonymous by design.
 *
 * Invariants (spec §"Storage"):
 *   - POST only; method-specific export gives an automatic 405 for anything else.
 *   - Same-origin only: Origin header must equal this request's own origin.
 *   - Hard body cap (a few KB); reject/ignore anything larger.
 *   - Validate `event` against the known set; silently drop unknown shapes.
 *   - Fail-soft: ANY internal error returns 204 so the client never breaks.
 *   - Never log or echo the request body. No PII is read or stored: we only ever
 *     persist event / device_class / browser / reason / session_id (the last is
 *     an in-memory per-page-load UUID, not an identity). IP is never recorded.
 */

// Minimal local binding type. functions/ is built by wrangler/esbuild (type-
// stripped, not typechecked by tsc), and @cloudflare/workers-types is not a
// dependency of this package, so we declare exactly the surface we use.
interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

interface Env {
  // Binding added to wrangler.toml; the dataset itself is created in the
  // Cloudflare dashboard by Lattice (see the deploy steps in the report).
  DEMO_EVENTS?: AnalyticsEngineDataset;
}

const KNOWN_EVENTS = new Set([
  "demo_clicked",
  "demo_model_loaded",
  "demo_first_token",
  "demo_finished",
  "demo_failed",
]);

const KNOWN_DEVICE_CLASSES = new Set(["mobile", "desktop", "unknown"]);

// A demo event payload is tiny (~150 bytes). Cap hard well above that.
const MAX_BODY = 2048;

// Always 204 — the client is fire-and-forget and must never see an error.
const noContent = (): Response => new Response(null, { status: 204 });

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  try {
    // Same-origin only. Reject cross-origin / missing Origin outright.
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin) {
      return new Response(null, { status: 403 });
    }

    // Hard size cap, checked before and after reading the body.
    const declared = Number(request.headers.get("Content-Length") || "0");
    if (declared > MAX_BODY) return noContent();
    const raw = await request.text();
    if (raw.length > MAX_BODY) return noContent();

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return noContent(); // malformed — drop silently
    }

    const event = typeof data.event === "string" ? data.event : "";
    if (!KNOWN_EVENTS.has(event)) return noContent(); // unknown shape — drop

    // Coerce + bound every field. Anything unexpected becomes empty/"unknown".
    const sessionId = typeof data.session_id === "string" ? data.session_id.slice(0, 64) : "";
    const browser = typeof data.browser === "string" ? data.browser.slice(0, 24) : "";
    const reason =
      event === "demo_failed" && typeof data.reason === "string" ? data.reason.slice(0, 32) : "";
    const deviceClass =
      typeof data.device_class === "string" && KNOWN_DEVICE_CLASSES.has(data.device_class)
        ? data.device_class
        : "unknown";

    // Analytics Engine mapping (only ONE index is allowed — it is the sampling
    // key, so it must be the lowest-cardinality field we group by most):
    //   indexes[0] = event        — the primary breakdown ("started vs finished
    //                               vs failed"); 5 possible values.
    //   blobs[0]   = device_class — the required second breakdown ("per device
    //                               class"); grouped via WHERE/GROUP BY blob1.
    //   blobs[1]   = browser      — coarse family for secondary slicing.
    //   blobs[2]   = reason       — demo_failed only, else "".
    //   blobs[3]   = session_id   — in-memory per-page-load UUID; lets analysis
    //                               correlate events of one run to infer tab-kill
    //                               by ABSENCE of a terminal event. Not identity.
    //   doubles    = none         — timestamp is supplied server-side by AE.
    // IP is never read or stored. No prompt/output text is in the path at all.
    env.DEMO_EVENTS?.writeDataPoint({
      indexes: [event],
      blobs: [deviceClass, browser, reason, sessionId],
    });

    return noContent();
  } catch {
    // Fail-soft: never surface an error to the demo.
    return noContent();
  }
};
