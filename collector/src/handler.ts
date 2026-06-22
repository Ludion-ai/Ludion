import { validateBenchDocument } from "../../bench/src/schema";
import { validateDecisionBatch, type DecisionEvent } from "../../shared/src/telemetry";
import { readAggregate, rebuildAggregate } from "./aggregate";
import { readDecisionAggregate, recordDecisionAggregate } from "./decisions";

/**
 * ludion-collector — Gate 2.7 submission intake (Cloudflare Worker).
 *
 * Pure request handler: all platform bindings are injected through the narrow
 * interfaces below so tests run on hand-rolled in-memory mocks (decisions Q2)
 * and `wrangler dev` covers the real-binding manual check.
 *
 * Privacy invariants (decisions F-4 — acceptance criteria, not afterthoughts):
 *  - the raw client IP is read once, hashed with a deploy-time salt, and used
 *    only as the rate-limit KV key; it is never stored, logged, or echoed;
 *  - the stored R2 object is the submitted JSON plus `received_at` ONLY.
 */

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface R2ObjectLike {
  key: string;
}

export interface R2Like {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options?: {
    cursor?: string;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

/** Minimal slice of the Worker ExecutionContext — only what we use (decisions OQ1). */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CollectorEnv {
  COLLECTOR_KV: KVLike;
  SUBMISSIONS: R2Like;
  /** Comma-separated browser origins allowed to call /v1/submit and /v1/stats. */
  ALLOWED_ORIGINS: string;
  /** Secret. Salts the rate-limit IP hash; rotating it resets counters. */
  IP_HASH_SALT: string;
  /** Secret. Bearer token for the read-only /v1/admin/* surface (decisions F-1). */
  ADMIN_TOKEN: string;
}

export const MAX_BODY_BYTES = 256 * 1024; // spec §2-1
export const DAILY_LIMIT = 10; // spec §2-2
const RATE_TTL_SECONDS = 172800; // 2 days — covers UTC-date stragglers (decisions Q1)
const STATS_KEY = "stats:total";

// --- decision telemetry (POST /v1/decisions) --------------------------------
// Route/schema/storage prefix are deliberately separated from bench submission.
/** A decision batch can carry up to MAX_BATCH_EVENTS events — a larger cap than bench docs. */
export const DECISIONS_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
/** Per-IP/day cap on decision batches — higher than bench (telemetry is higher-volume). */
export const DECISIONS_DAILY_LIMIT = 5000;
const DECISIONS_STATS_KEY = "decisions:total";
/** R2 key prefix for raw decision batches, kept apart from bench submissions. */
const DECISIONS_PREFIX = "decisions";
/** Project-id charset safe to embed in an R2 object key (no path traversal). */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type ErrorCode =
  | "method_not_allowed"
  | "origin_forbidden"
  | "too_large"
  | "invalid_json"
  | "schema_invalid"
  | "no_sessions"
  | "rate_limited"
  | "unauthorized"
  | "invalid_project"
  | "not_found";

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function allowedOrigins(env: CollectorEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Loopback dev origins (any port) are allowed in addition to the explicit
 * production allow-list, so the chat-test app and a CDN-loaded router running on
 * a local dev server can POST decision telemetry during end-to-end verification.
 * This is a deliberate dev convenience, NOT an open `*`: only http(s) loopback
 * hosts match, and every production origin still comes from ALLOWED_ORIGINS so
 * the real allow-list stays explicit and visible.
 */
function isLocalhostDevOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** An origin is allowed if it is an explicit production origin or a loopback dev origin. */
function isOriginAllowed(origin: string, env: CollectorEnv): boolean {
  return allowedOrigins(env).includes(origin) || isLocalhostDevOrigin(origin);
}

/**
 * CORS headers for the response. Browser requests from a foreign origin get no
 * CORS headers (the browser blocks the read); non-browser clients (no Origin
 * header) pass — CORS is a browser containment line, not authentication. The
 * specific allowed origin is echoed (never `*`), with `Vary: Origin` so a
 * shared cache never serves one origin's ACAO header to another.
 */
function corsHeaders(request: Request, env: CollectorEnv): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (origin !== null && isOriginAllowed(origin, env)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readCounter(kv: KVLike, key: string): Promise<number> {
  const raw = await kv.get(key);
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Best-effort counter bump: never turns an accepted submission into an error (decisions Q1). */
async function bumpCounter(kv: KVLike, key: string, ttl?: number): Promise<number> {
  return bumpCounterBy(kv, key, 1, ttl);
}

/** Best-effort counter bump by an arbitrary delta. Fail-open like `bumpCounter`. */
async function bumpCounterBy(kv: KVLike, key: string, delta: number, ttl?: number): Promise<number> {
  const next = (await readCounter(kv, key)) + delta;
  try {
    await kv.put(key, String(next), ttl !== undefined ? { expirationTtl: ttl } : undefined);
  } catch {
    // KV write limit / transient failure: fail-open on the counter.
  }
  return next;
}

async function handleSubmit(
  request: Request,
  env: CollectorEnv,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get("Origin");
  if (origin !== null && !isOriginAllowed(origin, env)) {
    return errorResponse(403, "origin_forbidden", "origin not allowed");
  }

  // Cheap pre-check; the decoded byte length is verified again after reading
  // so chunked bodies cannot sneak past (decisions F-6).
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return errorResponse(413, "too_large", `body exceeds ${MAX_BODY_BYTES} bytes`, cors);
  }

  // Rate limit BEFORE any body work. The raw IP's only use; see module header.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rateKey = `rl:${utcDate()}:${await sha256Hex(env.IP_HASH_SALT + ip)}`;
  if ((await readCounter(env.COLLECTOR_KV, rateKey)) >= DAILY_LIMIT) {
    return errorResponse(429, "rate_limited", `limit ${DAILY_LIMIT} submissions/day`, {
      ...cors,
      "Retry-After": "86400",
    });
  }

  const body = await request.text();
  const bodyBytes = new TextEncoder().encode(body);
  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    return errorResponse(413, "too_large", `body exceeds ${MAX_BODY_BYTES} bytes`, cors);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return errorResponse(400, "invalid_json", "body is not valid JSON", cors);
  }

  const result = validateBenchDocument(doc);
  if (!result.ok) {
    return errorResponse(
      400,
      "schema_invalid",
      `schema validation failed: ${result.errors.slice(0, 5).join("; ")}`,
      cors,
    );
  }
  const sessions = (doc as { sessions: unknown[] }).sessions;
  if (sessions.length < 1) {
    return errorResponse(400, "no_sessions", "document must contain at least 1 session", cors);
  }

  const json = { "content-type": "application/json", ...cors };

  // Dedupe on the exact submitted bytes (decisions F-5).
  const dedupeKey = `dedupe:${await sha256Hex(bodyBytes)}`;
  if ((await env.COLLECTOR_KV.get(dedupeKey)) !== null) {
    await bumpCounter(env.COLLECTOR_KV, rateKey, RATE_TTL_SECONDS);
    const total = await readCounter(env.COLLECTOR_KV, STATS_KEY);
    return new Response(JSON.stringify({ ok: true, deduped: true, total_submissions: total }), {
      status: 200,
      headers: json,
    });
  }

  // Store: submitted JSON + received_at, nothing else (spec §2-3).
  const key = `${utcDate()}/${crypto.randomUUID()}.json`;
  const stored = { ...(doc as Record<string, unknown>), received_at: new Date().toISOString() };
  await env.SUBMISSIONS.put(key, JSON.stringify(stored, null, 2));
  try {
    await env.COLLECTOR_KV.put(dedupeKey, key);
  } catch {
    // Dedupe index is an optimization; a lost write only allows a future re-store.
  }
  await bumpCounter(env.COLLECTOR_KV, rateKey, RATE_TTL_SECONDS);
  const total = await bumpCounter(env.COLLECTOR_KV, STATS_KEY);

  // Amortized aggregate refresh, off the response path so submit latency is
  // unchanged (decisions OQ1). New data only → deduped submits skip the rebuild.
  ctx?.waitUntil(rebuildAggregate(env).catch(() => undefined));

  return new Response(JSON.stringify({ ok: true, deduped: false, total_submissions: total }), {
    status: 200,
    headers: json,
  });
}

/**
 * POST /v1/decisions — opt-in, content-free decision telemetry intake.
 *
 * The body is a `DecisionBatch` validated by the shared allow-list validator
 * (`validateDecisionBatch`): unknown keys are rejected, so a prompt/completion/
 * secret field can never be stored. Raw batches land in R2 under a per-project
 * key (separated from bench), and per-project + total event counters go to KV.
 */
async function handleDecisions(request: Request, env: CollectorEnv): Promise<Response> {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get("Origin");
  if (origin !== null && !isOriginAllowed(origin, env)) {
    return errorResponse(403, "origin_forbidden", "origin not allowed");
  }

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > DECISIONS_MAX_BODY_BYTES) {
    return errorResponse(413, "too_large", `body exceeds ${DECISIONS_MAX_BODY_BYTES} bytes`, cors);
  }

  // Rate limit BEFORE body work, on a SEPARATE key prefix from bench (rld:).
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rateKey = `rld:${utcDate()}:${await sha256Hex(env.IP_HASH_SALT + ip)}`;
  if ((await readCounter(env.COLLECTOR_KV, rateKey)) >= DECISIONS_DAILY_LIMIT) {
    return errorResponse(429, "rate_limited", `limit ${DECISIONS_DAILY_LIMIT} decision batches/day`, {
      ...cors,
      "Retry-After": "86400",
    });
  }

  const body = await request.text();
  const bodyBytes = new TextEncoder().encode(body);
  if (bodyBytes.byteLength > DECISIONS_MAX_BODY_BYTES) {
    return errorResponse(413, "too_large", `body exceeds ${DECISIONS_MAX_BODY_BYTES} bytes`, cors);
  }

  let batch: unknown;
  try {
    batch = JSON.parse(body);
  } catch {
    return errorResponse(400, "invalid_json", "body is not valid JSON", cors);
  }

  const result = validateDecisionBatch(batch);
  if (!result.ok) {
    return errorResponse(
      400,
      "schema_invalid",
      `schema validation failed: ${result.errors.slice(0, 5).join("; ")}`,
      cors,
    );
  }

  const projectId = (batch as { projectId: string }).projectId;
  if (!PROJECT_ID_RE.test(projectId)) {
    return errorResponse(400, "invalid_project", "projectId must be 1-64 chars of [A-Za-z0-9_-]", cors);
  }

  const json = { "content-type": "application/json", ...cors };

  // Store the raw batch + received_at, nothing else; per-project key prefix.
  const key = `${DECISIONS_PREFIX}/${projectId}/${utcDate()}/${crypto.randomUUID()}.json`;
  const stored = { ...(batch as Record<string, unknown>), received_at: new Date().toISOString() };
  await env.SUBMISSIONS.put(key, JSON.stringify(stored));

  // Counters → KV: per-project + global event totals. Best-effort (fail-open).
  // Only event COUNTS are aggregated here — never a load_total_ms mean. That
  // field is an unlabeled bimodal mixture (see DecisionEvent.load_total_ms in
  // shared); any later summary must be p50/p90 via summarizeLoadTotalMs over
  // the raw events stored above, not an average computed at ingest.
  const events = (batch as { events: DecisionEvent[] }).events;
  const eventCount = events.length;
  await bumpCounter(env.COLLECTOR_KV, rateKey, RATE_TTL_SECONDS);
  await bumpCounterBy(env.COLLECTOR_KV, `decisions:project:${projectId}`, eventCount);
  const total = await bumpCounterBy(env.COLLECTOR_KV, DECISIONS_STATS_KEY, eventCount);

  // Per-project content-free aggregate for the /app "Project" scope: counts,
  // savings token sums, and the recent-N ring. Incremental KV (no R2 scan);
  // fail-open so it never turns an accepted ingest into an error.
  await recordDecisionAggregate(env.COLLECTOR_KV, projectId, events);

  return new Response(JSON.stringify({ ok: true, stored_events: eventCount, total_events: total }), {
    status: 200,
    headers: json,
  });
}

async function handleAggregate(request: Request, env: CollectorEnv, url: URL): Promise<Response> {
  const cors = corsHeaders(request, env);
  // `?projectId=` selects the per-project decision aggregate (the /app "Project"
  // scope); no param keeps the existing bench rollup. No admin token either way —
  // both surfaces are derived, content-free public data.
  const projectId = url.searchParams.get("projectId");
  if (projectId !== null) {
    if (!PROJECT_ID_RE.test(projectId)) {
      return errorResponse(400, "invalid_project", "projectId must be 1-64 chars of [A-Za-z0-9_-]", cors);
    }
    const aggregate = await readDecisionAggregate(env.COLLECTOR_KV, projectId);
    return new Response(JSON.stringify(aggregate), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Incrementally maintained in KV; O(1) read. Short cache so the dogfood
        // dashboard reflects fresh decisions without hammering the worker.
        "Cache-Control": "public, max-age=30",
        ...cors,
      },
    });
  }
  const aggregate = await readAggregate(env);
  return new Response(JSON.stringify(aggregate), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Precomputed in KV; O(1) per request regardless of submission count, and
      // edge/browser cache holds it for 300s (decisions OQ2; stale is accepted, F-8).
      "Cache-Control": "public, max-age=300",
      ...cors,
    },
  });
}

async function handleStats(request: Request, env: CollectorEnv, url: URL): Promise<Response> {
  const total = await readCounter(env.COLLECTOR_KV, STATS_KEY);
  // Decision ingestion is observable here as event COUNTS only — no content, no
  // means (see handleDecisions). `decisions_total` is the global event count;
  // `?projectId=` adds that project's event count so the chat-test app can
  // confirm its own ingestion end to end without the admin token.
  const decisionsTotal = await readCounter(env.COLLECTOR_KV, DECISIONS_STATS_KEY);
  const body: Record<string, number> = {
    total_submissions: total,
    decisions_total: decisionsTotal,
  };
  const projectId = url.searchParams.get("projectId");
  // Validate to the ingestion charset so a crafted id can never probe arbitrary KV keys.
  if (projectId !== null && PROJECT_ID_RE.test(projectId)) {
    body.decisions_project = await readCounter(env.COLLECTOR_KV, `decisions:project:${projectId}`);
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Cache-Control": "public, max-age=60",
      ...corsHeaders(request, env),
    },
  });
}

/** Read-only admin surface for pull-submissions (decisions F-1). No CORS: server-to-server. */
async function handleAdmin(request: Request, env: CollectorEnv, url: URL): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (env.ADMIN_TOKEN.length === 0 || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return errorResponse(401, "unauthorized", "missing or invalid bearer token");
  }
  if (url.pathname === "/v1/admin/list") {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await env.SUBMISSIONS.list(cursor !== undefined ? { cursor } : undefined);
    return new Response(
      JSON.stringify({
        keys: page.objects.map((o) => o.key),
        truncated: page.truncated,
        cursor: page.cursor ?? null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.pathname === "/v1/admin/object") {
    const key = url.searchParams.get("key");
    if (key === null) return errorResponse(404, "not_found", "missing key parameter");
    const object = await env.SUBMISSIONS.get(key);
    if (object === null) return errorResponse(404, "not_found", `no object at ${key}`);
    return new Response(await object.text(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return errorResponse(404, "not_found", "unknown admin route");
}

export async function handleRequest(
  request: Request,
  env: CollectorEnv,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request, env),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname === "/v1/submit") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "use POST", { Allow: "POST" });
    }
    return handleSubmit(request, env, ctx);
  }
  if (url.pathname === "/v1/decisions") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "use POST", { Allow: "POST" });
    }
    return handleDecisions(request, env);
  }
  if (url.pathname === "/v1/stats") {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "use GET", { Allow: "GET" });
    }
    return handleStats(request, env, url);
  }
  if (url.pathname === "/v1/aggregate") {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "use GET", { Allow: "GET" });
    }
    return handleAggregate(request, env, url);
  }
  if (url.pathname.startsWith("/v1/admin/")) {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "use GET", { Allow: "GET" });
    }
    return handleAdmin(request, env, url);
  }
  return errorResponse(404, "not_found", `no route ${url.pathname}`);
}
