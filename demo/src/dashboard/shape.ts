/*
 * Pure Overview data shapers (Workspace 2b-1). Every figure here is derived
 * from the CLIENT-SIDE SavingsLedger snapshot and the static model registry —
 * nothing is fetched from a Ludion server (§1). Kept pure (no DOM, no network,
 * no storage) so the number discipline is unit-tested in shape.test.ts.
 *
 * Note on fields the spec assumed but the store does not carry: the persisted
 * ledger has no request id and no latency (ttft/tps live only on the ephemeral
 * in-memory DecisionLog, never written). So the recent-decisions row exposes
 * what is real — time, model, routing, rule, token counts — and nothing faked.
 */
import type { LedgerEntry, DailyRollup, SavingsSummary } from "ludion-router/savings";
import { getModel, listModels } from "ludion-router/registry";
import type { ModelEntry } from "ludion-router/registry";

export interface Snapshot {
  entries: LedgerEntry[];
  rollups: DailyRollup[];
}

export interface OverviewStats {
  /** Routed = local + server (unroutable excluded). */
  routed: number;
  local: number;
  server: number;
  localPct: number;
  serverPct: number;
  /** Completed ÷ recorded entries, or null when there are no entries. */
  successRate: number | null;
}

export interface ModelShare {
  modelId: string;
  label: string;
  count: number;
  /** 0..1 of all routed requests. */
  share: number;
  kind: "api" | "local" | null;
  /** "on-device" | "verified" | "unverified" | null (no registry match). */
  status: string | null;
}

export type Routing = "on-device" | "fallback" | "unroutable";

export interface RecentRow {
  ts: string;
  model: string;
  routing: Routing;
  rule: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Does this snapshot hold any recorded decision at all? Drives the empty state. */
export function hasData(snap: Snapshot): boolean {
  return snap.entries.length > 0 || snap.rollups.length > 0;
}

/**
 * Resolve a ledger model string to its registry entry. Local entries log the
 * WebLLM id; api entries may log the canonical id or the provider model id —
 * try each. Returns undefined when nothing matches (then callers show the raw
 * string with no status, never an invented label).
 */
export function resolveModel(modelId: string): ModelEntry | undefined {
  const direct = getModel(modelId);
  if (direct) return direct;
  return listModels().find(
    (m) => m.webllm_model_id === modelId || m.provider_model_id === modelId,
  );
}

function statusOf(m: ModelEntry | undefined): string | null {
  if (!m) return null;
  if (m.kind === "local") return "on-device";
  return m.provider_model_id_verified ? "verified" : "unverified";
}

export function overviewStats(snap: Snapshot, summary: SavingsSummary): OverviewStats {
  const local = summary.local_count;
  const server = summary.server_count;
  const routed = local + server;
  const completed = snap.entries.filter((e) => e.completed).length;
  return {
    routed,
    local,
    server,
    localPct: routed === 0 ? 0 : (local / routed) * 100,
    serverPct: routed === 0 ? 0 : (server / routed) * 100,
    successRate: snap.entries.length === 0 ? null : completed / snap.entries.length,
  };
}

export function topModelsByShare(snap: Snapshot, limit = 4): ModelShare[] {
  const counts = new Map<string, number>();
  const add = (model: string, n: number) => counts.set(model, (counts.get(model) ?? 0) + n);
  for (const e of snap.entries) if (e.target !== "unroutable") add(e.model, 1);
  for (const r of snap.rollups) add(r.model, r.count);

  let total = 0;
  for (const n of counts.values()) total += n;

  return [...counts.entries()]
    .map(([modelId, count]): ModelShare => {
      const m = resolveModel(modelId);
      return {
        modelId,
        count,
        share: total === 0 ? 0 : count / total,
        label: m?.display_name ?? modelId,
        kind: m?.kind ?? null,
        status: statusOf(m),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface DaySeries {
  days: string[];
  /** local + server routed per day. */
  routed: number[];
  /** local (on-device) routed per day. */
  local: number[];
  /** savings (counterfactual cost avoided) per day. */
  saved: number[];
}

/**
 * Per-day series for the stat-tile sparklines and the savings area chart, taken
 * straight from `summary.by_day` (already sorted oldest-first by computeSavings).
 * Note: there is no honest per-day success-rate series — `by_day` carries no
 * completed/total split and the rollup fold drops the `completed` flag — so the
 * success-rate tile uses a gauge of the single aggregate instead, not a spark.
 */
export function dailySeries(summary: SavingsSummary): DaySeries {
  return {
    days: summary.by_day.map((d) => d.day),
    routed: summary.by_day.map((d) => d.local_count + d.server_count),
    local: summary.by_day.map((d) => d.local_count),
    saved: summary.by_day.map((d) => d.saved),
  };
}

function routingOf(target: LedgerEntry["target"]): Routing {
  return target === "local" ? "on-device" : target === "server" ? "fallback" : "unroutable";
}

export function recentDecisions(snap: Snapshot, limit = 8): RecentRow[] {
  // Entries are appended oldest-first; reverse for newest-first.
  return [...snap.entries]
    .reverse()
    .slice(0, limit)
    .map((e): RecentRow => ({
      ts: e.ts,
      model: resolveModel(e.model)?.display_name ?? e.model,
      routing: routingOf(e.target),
      rule: e.rule_id,
      tokensIn: e.tokens_in,
      tokensOut: e.tokens_out,
    }));
}
