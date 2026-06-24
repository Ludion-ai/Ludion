// The relay proxy (docs/recipes/nextjs-route-handler.md): the browser talks
// to this same-origin route, this route talks to your provider, and the API
// key never leaves the server.
//
// MINIMAL ABUSE GUARD (read this): because this route holds LLM_API_KEY, an
// unguarded version is an OPEN RELAY — any attacker page can POST to it from a
// victim's browser and spend your credits. The cross-origin response isn't
// readable by the attacker, but the BILL still lands on you (a spend DoS). The
// guards below make it usable ONLY by your own same-origin UI:
//   1. reject cross-site requests (Origin/Referer must match this deployment),
//   2. cap the request body size, and
//   3. require a minimally well-formed chat-completion body.
// This is a STARTER guard, not a security framework. Before exposing a real
// budget, add rate limiting and real auth (session/JWT) — see the recipe doc.

// A chat-completion request is small; anything larger is almost certainly abuse.
const MAX_BODY_BYTES = 32 * 1024; // 32 KB

/** Parse a URL/origin string to its host, or null if it isn't a valid URL. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Same-origin check. The allowed origin is THIS deployment's origin: set
 * APP_ORIGIN (e.g. https://your-app.com) for the most robust result behind a
 * proxy/CDN, otherwise we fall back to the request's own Host header. A POST
 * from your own page always carries a matching Origin; we reject anything else.
 */
function isSameOrigin(req: Request): boolean {
  const allowedHost = process.env.APP_ORIGIN
    ? hostOf(process.env.APP_ORIGIN)
    : req.headers.get("host");
  if (!allowedHost) return false;
  // Browsers send Origin on every POST (same-origin included); Referer is a
  // fallback for the rare client that omits Origin. No header → reject.
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  const sourceHost = source ? hostOf(source) : null;
  return sourceHost !== null && sourceHost === allowedHost;
}

/** Minimal shape check: an OpenAI chat-completion body is a JSON object with a messages array. */
function isChatBody(body: unknown): body is { messages: unknown[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { messages?: unknown }).messages)
  );
}

export async function POST(req: Request): Promise<Response> {
  // 1) Cross-site abuse guard — only our own UI may use this key-holding relay.
  if (!isSameOrigin(req)) {
    return Response.json({ error: "cross-site request rejected" }, { status: 403 });
  }

  // 2a) Cheap precheck: reject an oversized body before reading it, when the
  //     client declares Content-Length.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }

  // 2b) Hard cap on the actual decoded bytes (Content-Length may be absent or lie).
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }

  // 3) Minimal JSON + shape validation; reject malformed bodies early.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!isChatBody(body)) {
    return Response.json({ error: "invalid chat-completion body" }, { status: 400 });
  }

  const upstream = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: raw, // forwarded unchanged; SSE streams back as-is
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    },
  });
}
