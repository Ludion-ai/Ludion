/**
 * Decision telemetry sink (router core).
 *
 * The router core calls `emitDecision(log)` exactly once per request, at
 * terminal state, from `emitOnce` (index.ts) — alongside the consumer's
 * `onDecision`. The inference path therefore does ONE synchronous push into a
 * small in-memory buffer and nothing else: no network, no await, no throw, no
 * heavy serialization. The buffer is drained on a microtask, and every consumer
 * runs inside try/catch so a failing consumer can never surface to the caller.
 *
 * Until a consumer is registered (Commit B wires the local ledger; Commit C the
 * central transport) `emitDecision` is a no-op — zero cost, zero side effects.
 *
 * `toDecisionEvent` maps the internal `DecisionLog` to the shared, content-free
 * `DecisionEvent` (the schema both local and central use; only transport
 * differs). It reuses existing DecisionLog fields and derives `route` from the
 * target/degrade/error state — no parallel field names.
 */
import type { DecisionLog } from "./types";
import {
  DECISION_SCHEMA_VERSION,
  type DecisionEvent,
  type DecisionRoute,
} from "@ludion/shared";

export { DECISION_SCHEMA_VERSION } from "@ludion/shared";
export type { DecisionEvent } from "@ludion/shared";

/** A random per-decision id. Opaque — never derived from prompt content. */
export function newDecisionId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for environments without crypto.randomUUID — still content-free.
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Derive the public route label from the internal target/degrade/error state. */
function mapRoute(log: DecisionLog): DecisionRoute {
  if (log.error !== null || log.target === "unroutable") return "error";
  if (log.degraded === "local→server") return "fallback";
  return log.target === "local" ? "local" : "cloud";
}

function fallbackReason(log: DecisionLog, route: DecisionRoute): string | undefined {
  if (route === "fallback") return "local_unavailable";
  if (route === "error") {
    if (log.target === "unroutable") return "privacy_unroutable";
    if (log.degraded_failed) return "local_failed_mid_stream";
    return log.error ?? "error";
  }
  return undefined;
}

/** Map the internal DecisionLog → the shared, content-free DecisionEvent. */
export function toDecisionEvent(log: DecisionLog): DecisionEvent {
  const route = mapRoute(log);
  const reason = fallbackReason(log, route);
  const ts = Date.parse(log.decided_at);
  return {
    schema_version: DECISION_SCHEMA_VERSION,
    decision_id: log.decision_id,
    route,
    model: log.model,
    ...(log.tokens_in !== null ? { input_tokens: log.tokens_in } : {}),
    ...(log.tokens_out !== null ? { output_tokens: log.tokens_out } : {}),
    ...(log.ttft_ms !== null ? { latency_ms: log.ttft_ms } : {}),
    ...(log.load_total_ms !== null ? { load_total_ms: log.load_total_ms } : {}),
    cache_state: log.cache_state,
    device_class: log.probe.os_class,
    webgpu_supported: log.probe.webgpu,
    ...(reason !== undefined ? { fallback_reason: reason } : {}),
    timestamp: Number.isNaN(ts) ? Date.now() : ts,
  };
}

// --- the module-level sink --------------------------------------------------

export type DecisionConsumer = (log: DecisionLog) => void;

const consumers = new Set<DecisionConsumer>();
let buffer: DecisionLog[] = [];
let drainScheduled = false;

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  const schedule =
    typeof queueMicrotask === "function"
      ? queueMicrotask
      : (fn: () => void): void => void Promise.resolve().then(fn);
  schedule(drain);
}

function drain(): void {
  drainScheduled = false;
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  for (const log of batch) {
    for (const consume of consumers) {
      try {
        consume(log);
      } catch {
        // A consumer must never break the request or other consumers.
      }
    }
  }
}

/**
 * Register a consumer of every terminal decision. Returns an unsubscribe fn.
 * Consumers run off the inference path (microtask drain), wrapped in try/catch.
 */
export function registerDecisionConsumer(consumer: DecisionConsumer): () => void {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
}

/**
 * Core entry point: enqueue one terminal decision. Inference-path-safe — a
 * single synchronous buffer push (+ a one-shot microtask schedule). No-op while
 * no consumer is registered.
 */
export function emitDecision(log: DecisionLog): void {
  if (consumers.size === 0) return;
  buffer.push(log);
  scheduleDrain();
}

/** Test-only: clear consumers + buffer so unit tests stay independent. */
export function _resetTelemetry(): void {
  consumers.clear();
  buffer = [];
  drainScheduled = false;
}
