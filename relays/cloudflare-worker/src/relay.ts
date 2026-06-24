/**
 * Ludion canonical fallback relay (Cloudflare Worker) — Workspace v1, first piece.
 *
 * Pure request handler: the platform `env` is injected, and the upstream call
 * goes through an injectable `fetch` so tests run on hand-rolled mocks (matching
 * the collector's convention) and `wrangler dev` covers the real-binding check.
 *
 * SECURITY POINT (do not weaken): the provider API key is read ONLY from the
 * Worker secret `env.PROVIDER_API_KEY` and injected as the upstream
 * `Authorization: Bearer`. The relay never accepts or forwards a provider key
 * from the browser. The incoming `Authorization` header is the RELAY token — it
 * is validated and then DROPPED; it never reaches the upstream. The browser
 * therefore carries no provider key.
 *
 * AUTH BOUNDARY: the relay token (`env.RELAY_TOKEN`) is the auth boundary and is
 * REQUIRED by default — a request without a valid token is rejected with 401
 * before the upstream or the provider secret is touched. The origin allow-list
 * is defense-in-depth ONLY: CORS does not stop a non-browser caller (curl, a
 * server) that ignores it, so an origin-only relay would be an open proxy to the
 * provider key. The token, not the origin, is what gates the relay.
 *
 * KEY CUSTODY: the provider key exists only inside the Worker. Prompt/output
 * content is streamed straight through and never read, logged, or stored.
 */

export interface RelayEnv {
  /**
   * Secret. Provider API key, injected as the upstream Authorization Bearer.
   * Set with `wrangler secret put PROVIDER_API_KEY`. Never sent by the browser.
   */
  PROVIDER_API_KEY: string;
  /**
   * OpenAI-compatible upstream base URL, e.g. "https://api.openai.com/v1".
   * "/chat/completions" is appended (matches the router's URL shape).
   */
  UPSTREAM_BASE_URL: string;
  /** Comma-separated browser origins allowed to call the relay. */
  ALLOWED_ORIGINS: string;
  /**
   * Secret. The auth boundary, REQUIRED by default: the browser must present
   * `Authorization: Bearer <RELAY_TOKEN>`. This is a low-value, rotatable,
   * origin-scoped gate token — NOT the provider key, and NOT key custody. A
   * leaked token only lets someone spend through this relay; rotate it with
   * `wrangler secret put RELAY_TOKEN`. Set with `wrangler secret put RELAY_TOKEN`.
   */
  RELAY_TOKEN?: string;
  /**
   * DANGER opt-out. "true" or "1" disables the token gate entirely, leaving an
   * open proxy to your provider key for anyone who learns the URL. Only for
   * advanced setups with their own auth in front of the relay. Default off.
   */
  RELAY_OPEN?: string;
  /**
   * Optional native Workers rate-limiting binding (see wrangler.toml + README).
   * When bound, each request is counted per client IP and refused with 429 over
   * the cap. Absent (default in the template) → no rate limiting; the token gate
   * is the only protection until you enable it.
   */
  RATE_LIMITER?: RateLimiter;
}

/** The slice of the native Workers rate-limiting binding the relay uses. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Injectable fetch so tests drive a mock upstream; defaults to global fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RELAY_PATH = "/chat/completions";

// A chat-completion request is small; anything larger is almost certainly abuse.
const MAX_BODY_BYTES = 32 * 1024; // 32 KB

/** Minimal shape check: an OpenAI chat-completion body is a JSON object with a messages array. */
function isChatBody(body: unknown): body is { messages: unknown[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { messages?: unknown }).messages)
  );
}

function allowedOrigins(env: RelayEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * CORS headers. A browser request from an allow-listed Origin is reflected;
 * any other Origin gets none (the browser blocks the read). Never a silent `*`.
 * Defense-in-depth only — CORS is a browser containment line, not auth.
 */
function corsHeaders(request: Request, env: RelayEnv): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (origin !== null && allowedOrigins(env).includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toUpstreamUrl(env: RelayEnv): string {
  return `${env.UPSTREAM_BASE_URL.replace(/\/+$/, "")}${RELAY_PATH}`;
}

function relayIsOpen(env: RelayEnv): boolean {
  const v = (env.RELAY_OPEN ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Constant-time string equality via SHA-256 digests. Comparing two fixed 32-byte
 * digests removes the input-length timing leak and equalizes the byte compare,
 * so neither the token length nor a matching prefix is observable from timing.
 * The token is never logged.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  }
  return diff === 0;
}

export async function handleRelay(
  request: Request,
  env: RelayEnv,
  doFetch: FetchLike = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname !== RELAY_PATH) {
    return errorResponse(404, "not_found", `no route ${url.pathname}`, cors);
  }
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "use POST", { ...cors, Allow: "POST" });
  }

  // Defense-in-depth: a foreign Origin is refused, but this is NOT the auth
  // boundary (a non-browser caller sends no Origin and ignores CORS). The token
  // gate below is the boundary.
  const origin = request.headers.get("Origin");
  if (origin !== null && !allowedOrigins(env).includes(origin)) {
    return errorResponse(403, "origin_forbidden", "origin not allowed");
  }

  // Auth boundary: relay token REQUIRED by default. Rejected before the upstream
  // or the provider secret is touched. The presented Bearer is the relay token,
  // never a provider key — it is validated here and then dropped (not forwarded).
  if (!relayIsOpen(env)) {
    if (env.RELAY_TOKEN === undefined || env.RELAY_TOKEN.length === 0) {
      // Fail closed: a missing token secret must never silently become open.
      return errorResponse(
        500,
        "misconfigured",
        "relay has no RELAY_TOKEN secret (set it, or set RELAY_OPEN=true to run an open relay)",
        cors,
      );
    }
    const presented = request.headers.get("Authorization") ?? "";
    if (!(await constantTimeEqual(presented, `Bearer ${env.RELAY_TOKEN}`))) {
      return errorResponse(401, "unauthorized", "missing or invalid relay token", cors);
    }
  }

  if (env.PROVIDER_API_KEY === undefined || env.PROVIDER_API_KEY.length === 0) {
    return errorResponse(500, "misconfigured", "relay has no PROVIDER_API_KEY secret", cors);
  }

  // Optional rate limit (native Workers binding). Per client IP so one abuser of
  // a leaked token cannot drain the whole app's budget. Off unless bound.
  if (env.RATE_LIMITER !== undefined) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return errorResponse(429, "rate_limited", "too many requests", { ...cors, "Retry-After": "60" });
    }
  }

  // Body abuse guard (placed AFTER the auth/origin gates so unauthorized callers
  // short-circuit first). Cap the size, then require a minimally well-formed
  // chat-completion body. Cheap precheck on the declared Content-Length, then a
  // hard cap on the actual decoded bytes (Content-Length may be absent or lie).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return errorResponse(413, "payload_too_large", "request body too large", cors);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return errorResponse(413, "payload_too_large", "request body too large", cors);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorResponse(400, "invalid_json", "invalid JSON body", cors);
  }
  if (!isChatBody(parsed)) {
    return errorResponse(400, "invalid_body", "invalid chat-completion body", cors);
  }

  // Provider key is injected here from the secret. The browser's Authorization
  // (relay token, if any) is intentionally NOT forwarded.
  const upstream = await doFetch(toUpstreamUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.PROVIDER_API_KEY}`,
    },
    body,
  });

  // Stream the upstream body straight through (token-by-token for SSE; no
  // buffering). Preserve the upstream content-type so text/event-stream and
  // application/json both pass unchanged. Never cache provider responses.
  const headers = new Headers(cors);
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
}
