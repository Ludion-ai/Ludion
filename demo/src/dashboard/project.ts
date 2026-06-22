/*
 * Project-scope adapter: map the collector's per-project decision aggregate
 * (GET <collector>/v1/aggregate?projectId=<id>) onto the SAME OverviewData the
 * local-ledger view feeds renderOverview. Nothing here renders — it reshapes the
 * content-free aggregate so the EXISTING cards and the EXISTING savings logic
 * (computeSavings) are reused verbatim for the "Project" scope.
 *
 * Reuse strategy (and its honest limits):
 *  - Headline tiles (Requests routed, On-device, Cost saved) come from `summary`,
 *    built by pricing the aggregate's cumulative token sums with computeSavings —
 *    so they stay exact at any project volume.
 *  - The recent-decisions table, the models card, and the success-rate gauge are
 *    derived from the last-N rows the aggregate carries (a bounded window), which
 *    equals the full set at dogfood scale and degrades gracefully beyond it.
 *  - The wire schema (decision.v1) is content-free and carries NO policy rule id,
 *    so the recent table's Rule column shows a dash rather than inventing one.
 *
 * The ProjectAggregate interface mirrors collector/src/decisions.ts
 * (DecisionAggregate) — a deliberate wire-contract duplication across the
 * package boundary; keep the two in sync when either side changes.
 */
import { computeSavings } from "ludion-router/savings";
import type {
  DailyRollup,
  LedgerEntry,
  PriceBasis,
  SavingsSummary,
} from "ludion-router/savings";
import type { StoredConfig } from "ludion-workspace/schema";
import type { OverviewData } from "./overview";
import type { Snapshot } from "./shape";

/** decision.v1 routes, as carried in the aggregate's recent rows. */
type DecisionRoute = "local" | "cloud" | "fallback" | "error";

export interface ProjectAggregateRecent {
  /** Epoch ms. */
  t: number;
  model: string;
  route: DecisionRoute;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface ProjectAggregate {
  schema: "ludion.decisions.aggregate.v0";
  projectId: string;
  updated_at: string | null;
  routed: number;
  on_device: number;
  fallback: number;
  success: number;
  error: number;
  saved_tokens_in: number;
  saved_tokens_out: number;
  by_model: Record<string, number>;
  recent: ProjectAggregateRecent[];
}

/** The recent table's Rule column: the content-free wire schema carries no rule. */
const NO_RULE = "—";

/**
 * An aggregate with no decisions collected yet — drives the Overview empty state
 * (an opt-in prompt) instead of a wall of zeros. A 200 empty shell from the
 * collector (unknown / freshly-created project) lands here too. Errors count as
 * collected data, so a project that only logged failures is NOT empty.
 */
export function isEmptyAggregate(agg: ProjectAggregate): boolean {
  return agg.routed === 0 && agg.error === 0;
}

function isoOf(t: number): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Map one content-free recent row to a LedgerEntry the existing shapers read. */
function toEntry(r: ProjectAggregateRecent): LedgerEntry {
  const ts = isoOf(r.t);
  const target: LedgerEntry["target"] =
    r.route === "local" ? "local" : r.route === "error" ? "unroutable" : "server";
  return {
    ts,
    day: ts.slice(0, 10),
    target,
    rule_id: NO_RULE,
    model: r.model,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    tokens_source: r.tokens_in === null ? "estimated" : "exact",
    est_prompt_tokens: 0,
    completed: r.route !== "error",
  };
}

/**
 * Build a SavingsSummary from the aggregate's CUMULATIVE counts and token sums by
 * pricing a synthetic rollup with the same basis the local ledger uses. Routed/
 * on-device counts and Cost saved are therefore exact regardless of the recent
 * window. Savings is priced on local rows only (mirrors computeSavings).
 */
function toSummary(agg: ProjectAggregate, basis: PriceBasis): SavingsSummary {
  const day = (agg.updated_at ?? new Date().toISOString()).slice(0, 10);
  const rollups: DailyRollup[] = [];
  if (agg.on_device > 0) {
    rollups.push({
      day,
      target: "local",
      model: "(project)",
      tokens_source: "exact",
      tokens_in: agg.saved_tokens_in,
      tokens_out: agg.saved_tokens_out,
      count: agg.on_device,
    });
  }
  if (agg.fallback > 0) {
    rollups.push({
      day,
      target: "server",
      model: "(project)",
      tokens_source: "exact",
      tokens_in: 0,
      tokens_out: 0,
      count: agg.fallback,
    });
  }
  return computeSavings({ version: 1, entries: [], rollups }, basis);
}

/**
 * Reshape a project aggregate into OverviewData for renderOverview. `snapshot`
 * carries the recent rows as entries (no rollups, so the models/recent cards are
 * not double-counted against the cumulative summary); `summary` carries the
 * exact cumulative figures.
 */
export function projectOverviewData(
  agg: ProjectAggregate,
  basis: PriceBasis,
  config: StoredConfig | null,
  subtitle: string,
): OverviewData {
  const snapshot: Snapshot = {
    entries: agg.recent.map(toEntry),
    rollups: [],
  };
  return { snapshot, summary: toSummary(agg, basis), config, subtitle };
}
