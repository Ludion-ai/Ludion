/**
 * Shared decision-telemetry schema (decision.v1). Local ledger and central
 * collection use this ONE event shape; only transport differs. It is derived
 * from the router's internal `DecisionLog` (router/src/types.ts) — see
 * `toDecisionEvent` in router/src/telemetry.ts for the mapping.
 *
 * CONTENT-FREE IS ABSOLUTE: no prompt text, no completion text, no PII, no
 * keys/tokens. The shape carries only counts, routing metadata, and device
 * capability. The central validator (`validateDecisionEvent`) enforces this
 * structurally via an allow-list — an unknown key (which is how a content or
 * secret field would arrive) is rejected, so the guarantee does not rest on a
 * substring filter.
 */

export const DECISION_SCHEMA_VERSION = "decision.v1" as const;

export type DecisionRoute = "local" | "cloud" | "fallback" | "error";
export type DecisionCacheState = "cold" | "warm" | "unknown";

export interface DecisionEvent {
  schema_version: typeof DECISION_SCHEMA_VERSION;
  /** Unique per-decision id. Random/opaque — NEVER derived from prompt content. */
  decision_id: string;
  route: DecisionRoute;
  model: string;
  task?: string;
  input_tokens?: number;
  output_tokens?: number;
  /** Reconciled from the router's ttft_ms (time to first content token). */
  latency_ms?: number;
  /** Wall time of a cold on-device model load; absent when warm or no load. */
  load_total_ms?: number;
  cache_state?: DecisionCacheState;
  /** RouterProbe.os_class — the capability axis, not an identity. */
  device_class?: string;
  webgpu_supported: boolean;
  fallback_reason?: string;
  /** Epoch ms. */
  timestamp: number;
}

/** The keys an event may carry. Anything else is rejected (content-free gate). */
const ALLOWED_EVENT_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "decision_id",
  "route",
  "model",
  "task",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "load_total_ms",
  "cache_state",
  "device_class",
  "webgpu_supported",
  "fallback_reason",
  "timestamp",
]);

const ROUTES: ReadonlySet<string> = new Set(["local", "cloud", "fallback", "error"]);
const CACHE_STATES: ReadonlySet<string> = new Set(["cold", "warm", "unknown"]);

export interface DecisionValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate one event: well-formed AND content-free. The allow-list is the
 * content-free guarantee — a prompt/completion/secret field is an unknown key
 * and is rejected. Type checks are minimal but reject anything object-shaped
 * (no nested structures where content could hide).
 */
export function validateDecisionEvent(value: unknown, path = "event"): DecisionValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [`${path} must be an object`] };
  }
  const e = value as Record<string, unknown>;

  for (const k of Object.keys(e)) {
    if (!ALLOWED_EVENT_KEYS.has(k)) {
      errors.push(`${path}.${k} is not an allowed field (events are content-free)`);
    }
  }

  if (e.schema_version !== DECISION_SCHEMA_VERSION) {
    errors.push(`${path}.schema_version must be "${DECISION_SCHEMA_VERSION}"`);
  }
  if (typeof e.decision_id !== "string" || e.decision_id.length === 0) {
    errors.push(`${path}.decision_id must be a non-empty string`);
  }
  if (typeof e.route !== "string" || !ROUTES.has(e.route)) {
    errors.push(`${path}.route must be one of local|cloud|fallback|error`);
  }
  if (typeof e.model !== "string") {
    errors.push(`${path}.model must be a string`);
  }
  if (typeof e.webgpu_supported !== "boolean") {
    errors.push(`${path}.webgpu_supported must be a boolean`);
  }
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) {
    errors.push(`${path}.timestamp must be a number`);
  }
  for (const k of ["task", "device_class", "fallback_reason"] as const) {
    if (e[k] !== undefined && typeof e[k] !== "string") errors.push(`${path}.${k} must be a string`);
  }
  for (const k of ["input_tokens", "output_tokens", "latency_ms", "load_total_ms"] as const) {
    if (e[k] !== undefined && (typeof e[k] !== "number" || !Number.isFinite(e[k]))) {
      errors.push(`${path}.${k} must be a number`);
    }
  }
  if (e.cache_state !== undefined && (typeof e.cache_state !== "string" || !CACHE_STATES.has(e.cache_state))) {
    errors.push(`${path}.cache_state must be one of cold|warm|unknown`);
  }

  return { ok: errors.length === 0, errors };
}

/** A wire batch: a project id plus an array of content-free events. */
export interface DecisionBatch {
  schema_version: typeof DECISION_SCHEMA_VERSION;
  projectId: string;
  install_id: string;
  events: DecisionEvent[];
}

/** Maximum events per batch the collector accepts (matches the client flush cap). */
export const MAX_BATCH_EVENTS = 500;

/** Validate a POST /v1/decisions body: shape + every event content-free. */
export function validateDecisionBatch(value: unknown): DecisionValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["batch must be an object"] };
  }
  const b = value as Record<string, unknown>;
  const errors: string[] = [];
  const allowed = new Set(["schema_version", "projectId", "install_id", "events"]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) errors.push(`batch.${k} is not an allowed field`);
  }
  if (b.schema_version !== DECISION_SCHEMA_VERSION) {
    errors.push(`batch.schema_version must be "${DECISION_SCHEMA_VERSION}"`);
  }
  if (typeof b.projectId !== "string" || b.projectId.length === 0) {
    errors.push("batch.projectId must be a non-empty string");
  }
  if (typeof b.install_id !== "string" || b.install_id.length === 0) {
    errors.push("batch.install_id must be a non-empty string");
  }
  if (!Array.isArray(b.events)) {
    errors.push("batch.events must be an array");
    return { ok: false, errors };
  }
  if (b.events.length === 0) errors.push("batch.events must not be empty");
  if (b.events.length > MAX_BATCH_EVENTS) errors.push(`batch.events exceeds ${MAX_BATCH_EVENTS}`);
  b.events.forEach((ev, i) => {
    const r = validateDecisionEvent(ev, `events[${i}]`);
    if (!r.ok) errors.push(...r.errors);
  });
  return { ok: errors.length === 0, errors };
}
