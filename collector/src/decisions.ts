/**
 * ludion-collector — per-project decision aggregate (content-free).
 *
 * The `/v1/decisions` intake keeps only flat event counters in KV. The `/app`
 * dashboard needs more to drive its existing cards under the "Project" scope:
 * routed/on-device/fallback/success/error counts, the token sums computeSavings
 * needs (local-completed in/out), and the last N decisions for the recent table.
 *
 * This is produced INCREMENTALLY at ingest (a read-modify-write of one KV key
 * per project), NOT by scanning the project's R2 objects on each request — the
 * bench aggregate's R2-list rebuild (aggregate.ts) is the wrong tool here. The
 * fold is pure and unit-tested; the KV wrapper is fail-open like the counters.
 *
 * CONTENT-FREE: every field is a count, a token number, a model id, a route
 * enum, or a timestamp. No prompt/completion text, no decision_id, no PII. The
 * source events are already allow-list validated (shared/telemetry), so nothing
 * content-shaped can reach the recent ring.
 */
import type { DecisionEvent, DecisionRoute } from "../../shared/src/telemetry";
import type { KVLike } from "./handler";

export const DECISIONS_AGGREGATE_SCHEMA = "ludion.decisions.aggregate.v0" as const;

/** KV key prefix for the per-project decision aggregate (separate from counters). */
const DECISIONS_AGG_PREFIX = "decisions:agg:";

/** Cap on the recent-decisions ring kept per project (content-free rows). */
export const DECISIONS_AGG_RECENT_MAX = 50;

/** One content-free row for the Recent decisions table. */
export interface DecisionAggregateRecent {
  /** Epoch ms (DecisionEvent.timestamp). */
  t: number;
  model: string;
  route: DecisionRoute;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface DecisionAggregate {
  schema: typeof DECISIONS_AGGREGATE_SCHEMA;
  projectId: string;
  updated_at: string | null;
  /** on_device + fallback (error excluded, mirrors the dashboard's "routed"). */
  routed: number;
  /** route === "local". */
  on_device: number;
  /** route === "fallback" | "cloud" (cloud-served). */
  fallback: number;
  /** routed, non-error (== routed here). */
  success: number;
  /** route === "error". */
  error: number;
  /** Σ input_tokens over local (priced by computeSavings as would-be cost). */
  saved_tokens_in: number;
  /** Σ output_tokens over local. */
  saved_tokens_out: number;
  /** Routed count per model (error excluded), for the Models card. */
  by_model: Record<string, number>;
  /** Last N content-free rows, oldest-first. */
  recent: DecisionAggregateRecent[];
}

export function emptyDecisionAggregate(projectId: string): DecisionAggregate {
  return {
    schema: DECISIONS_AGGREGATE_SCHEMA,
    projectId,
    updated_at: null,
    routed: 0,
    on_device: 0,
    fallback: 0,
    success: 0,
    error: 0,
    saved_tokens_in: 0,
    saved_tokens_out: 0,
    by_model: {},
    recent: [],
  };
}

/**
 * Fold a batch of validated events into the running aggregate. Pure: returns a
 * new aggregate, never mutates `prev`. Route → bucket mapping mirrors the
 * dashboard's local-ledger semantics (local → on-device, fallback/cloud →
 * fallback, error → neither routed nor a model row). Only local rows feed the
 * savings token sums (computeSavings prices local-completed only).
 */
export function foldDecisionEvents(
  prev: DecisionAggregate,
  events: readonly DecisionEvent[],
): DecisionAggregate {
  const agg: DecisionAggregate = {
    ...prev,
    by_model: { ...prev.by_model },
    recent: [...prev.recent],
  };
  for (const e of events) {
    if (e.route === "error") {
      agg.error += 1;
    } else {
      if (e.route === "local") agg.on_device += 1;
      else agg.fallback += 1; // "fallback" | "cloud"
      agg.routed += 1;
      agg.success += 1;
      agg.by_model[e.model] = (agg.by_model[e.model] ?? 0) + 1;
      if (e.route === "local") {
        agg.saved_tokens_in += e.input_tokens ?? 0;
        agg.saved_tokens_out += e.output_tokens ?? 0;
      }
    }
    agg.recent.push({
      t: e.timestamp,
      model: e.model,
      route: e.route,
      tokens_in: e.input_tokens ?? null,
      tokens_out: e.output_tokens ?? null,
    });
  }
  if (agg.recent.length > DECISIONS_AGG_RECENT_MAX) {
    agg.recent = agg.recent.slice(agg.recent.length - DECISIONS_AGG_RECENT_MAX);
  }
  agg.updated_at = new Date().toISOString();
  return agg;
}

/** Read the per-project aggregate; empty-but-valid shell if never built. */
export async function readDecisionAggregate(
  kv: KVLike,
  projectId: string,
): Promise<DecisionAggregate> {
  const raw = await kv.get(DECISIONS_AGG_PREFIX + projectId);
  if (raw === null) return emptyDecisionAggregate(projectId);
  try {
    const parsed = JSON.parse(raw) as DecisionAggregate;
    if (parsed.schema === DECISIONS_AGGREGATE_SCHEMA) return parsed;
  } catch {
    // fall through to a fresh shell
  }
  return emptyDecisionAggregate(projectId);
}

/**
 * Incrementally fold a batch into the per-project aggregate (read-modify-write
 * of one KV key). Fail-open: a lost write never turns an accepted ingest into an
 * error — the next batch re-reads and continues. Last-write-wins under
 * concurrent batches is accepted (same approximate-counter posture as the
 * existing decision counters; dogfood scale is single-writer).
 */
export async function recordDecisionAggregate(
  kv: KVLike,
  projectId: string,
  events: readonly DecisionEvent[],
): Promise<void> {
  const prev = await readDecisionAggregate(kv, projectId);
  const next = foldDecisionEvents(prev, events);
  try {
    await kv.put(DECISIONS_AGG_PREFIX + projectId, JSON.stringify(next));
  } catch {
    // KV write limit / transient failure: fail-open, mirror bumpCounter.
  }
}
