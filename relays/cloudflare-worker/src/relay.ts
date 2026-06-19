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
 * from the browser. The incoming `Authorization` header (if any) is the optional
 * low-value RELAY token — it is checked and then DROPPED; it never reaches the
 * upstream. The browser therefore carries no provider key.
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
   * Optional. When set (non-empty), the browser must present
   * `Authorization: Bearer <RELAY_TOKEN>`. This is a low-value, rotatable,
   * origin-scoped gate token — NOT the provider key, and not key custody. When
   * unset, the relay is open to allow-listed origins (CORS is containment, not
   * authentication). See the README tradeoff.
   */
  RELAY_TOKEN?: string;
}

/** Injectable fetch so tests drive a mock upstream; defaults to global fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RELAY_PATH = "/chat/completions";

function allowedOrigins(env: RelayEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * CORS headers. A browser request from an allow-listed Origin is reflected;
 * any other Origin gets none (the browser blocks the read). Never a silent `*`.
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

/**
 * Constant-time-ish equality for the relay token. The token is low-value, but
 * avoid early-exit length/byte leaks anyway.
 */
function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const want = `Bearer ${expected}`;
  if (presented.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) {
    diff |= presented.charCodeAt(i) ^ want.charCodeAt(i);
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

  // Origin containment (CORS is not auth, but a foreign Origin is still refused).
  const origin = request.headers.get("Origin");
  if (origin !== null && !allowedOrigins(env).includes(origin)) {
    return errorResponse(403, "origin_forbidden", "origin not allowed");
  }

  // Optional relay-token gate. The presented Bearer is the RELAY token, never a
  // provider key — it is validated here and then dropped (not forwarded).
  if (env.RELAY_TOKEN !== undefined && env.RELAY_TOKEN.length > 0) {
    if (!tokenMatches(request.headers.get("Authorization"), env.RELAY_TOKEN)) {
      return errorResponse(401, "unauthorized", "missing or invalid relay token", cors);
    }
  }

  if (env.PROVIDER_API_KEY === undefined || env.PROVIDER_API_KEY.length === 0) {
    return errorResponse(500, "misconfigured", "relay has no PROVIDER_API_KEY secret", cors);
  }

  const body = await request.text();

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
