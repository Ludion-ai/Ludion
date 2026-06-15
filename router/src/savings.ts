/**
 * Client-side savings engine (Gate 6-A): measurement + computation only — NO
 * UI (that's 6-B), NO server, NO key storage. Everything is localStorage, so
 * it is consistent with Ludion's "data never leaves the device" premise: a
 * savings tracker that phoned home to compute totals would contradict the
 * whole claim.
 *
 * Opt-in by construction (§5): the router core writes no storage for savings.
 * An integrator turns this on by wiring the helper to `onDecision`:
 *
 *   const ledger = new SavingsLedger();
 *   const ludion = Ludion.create({ onDecision: (log) => ledger.record(log) });
 *
 * No `SavingsLedger` instance ⇒ nothing is ever written. The ledger stores
 * COUNTS AND METADATA ONLY — never prompt or response content (the source
 * DecisionLog carries no content, and this schema has no content field, so the
 * privacy guarantee is structural, not a filter).
 */
import type { DecisionLog } from "./types";
import type { KV } from "./strikes";
import { createSafeBrowserKV } from "./strikes";
import { PRESET_PRICING, PricingStore } from "./pricing";
import type { PriceBasis, PricingTable } from "./pricing";

// Re-export the pricing surface so consumers of the `ludion-router/savings`
// entry get the ledger, the summary, AND the pricing controls (preset table +
// store) from one import. Additive surface only — no behavior change.
export { PRESET_PRICING, PricingStore } from "./pricing";
export type { PriceRow, PricingTable, PriceBasis, PriceOverride } from "./pricing";

const LEDGER_KEY = "ludion.savings.ledger.v1";

/** Ring-buffer cap on raw entries; older entries fold into daily rollups. */
export const MAX_ENTRIES = 10_000;
/** Rollups older than this many days are pruned (bounded storage, §1). */
export const ROLLUP_RETENTION_DAYS = 90;

/** One recorded request — counts & metadata ONLY, never content. */
export interface LedgerEntry {
  ts: string;
  /** "YYYY-MM-DD", derived from ts; the rollup/by-day key. */
  day: string;
  target: "local" | "server" | "unroutable";
  rule_id: string;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_source: "exact" | "estimated";
  /** For estimated entries with null tokens_in: backfill source. */
  est_prompt_tokens: number;
  completed: boolean;
}

/** Folded-down older entries — still count-only. */
export interface DailyRollup {
  day: string;
  target: "local" | "server";
  model: string;
  tokens_source: "exact" | "estimated";
  tokens_in: number;
  tokens_out: number;
  count: number;
}

interface LedgerBlob {
  version: 1;
  entries: LedgerEntry[];
  rollups: DailyRollup[];
}

/** The summary 6-B renders. Defined cleanly here; 6-B depends on this shape. */
export interface SavingsSummary {
  total_saved: number;
  currency: "USD";
  by_day: Array<{ day: string; saved: number; local_count: number; server_count: number }>;
  local_count: number;
  server_count: number;
  total_requests: number;
  /** estimated-local entries ÷ local entries (count-based); 0 when no local. */
  estimated_fraction: number;
  pricing_basis: {
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    price_as_of: string;
    source: string;
    verified: boolean;
    overridden: boolean;
  };
}

function freshBlob(): LedgerBlob {
  return { version: 1, entries: [], rollups: [] };
}

function dayOf(ts: string): string {
  return ts.slice(0, 10); // ISO date prefix; "" stays "" for a bad ts
}

/** Backfilled effective input tokens for an entry (estimated entries only). */
function effectiveTokensIn(e: { tokens_in: number | null; est_prompt_tokens: number }): number {
  return e.tokens_in ?? e.est_prompt_tokens;
}

/**
 * Accumulating ledger. `record` matches the `onDecision` callback signature so
 * the integrator wires it directly. Fail-open like StrikeStore (never throws).
 */
export class SavingsLedger {
  constructor(
    private readonly kv: KV = createSafeBrowserKV(),
    private readonly now: () => number = Date.now,
    /** Ring-buffer cap; overridable for tests/tuning (default MAX_ENTRIES). */
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  private read(): LedgerBlob {
    try {
      const raw = this.kv.getItem(LEDGER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LedgerBlob;
        if (parsed.version === 1 && Array.isArray(parsed.entries) && Array.isArray(parsed.rollups)) {
          return parsed;
        }
      }
    } catch {
      // fall through to fresh blob
    }
    return freshBlob();
  }

  private write(blob: LedgerBlob): void {
    try {
      this.kv.setItem(LEDGER_KEY, JSON.stringify(blob));
    } catch {
      // never throw
    }
  }

  /** Record one decision. Counts/metadata only — content is never read. */
  record(log: DecisionLog): void {
    const ts = log.decided_at ?? new Date(this.now()).toISOString();
    const entry: LedgerEntry = {
      ts,
      day: dayOf(ts),
      target: log.target,
      rule_id: log.rule_id,
      model: log.model,
      tokens_in: log.tokens_in,
      tokens_out: log.tokens_out,
      tokens_source: log.tokens_source,
      est_prompt_tokens: log.est_prompt_tokens,
      completed: log.completed,
    };
    const blob = this.read();
    blob.entries.push(entry);
    this.bound(blob);
    this.write(blob);
  }

  /**
   * Keep storage bounded: when raw entries exceed MAX_ENTRIES, fold the oldest
   * overflow into daily rollups; prune rollups beyond the retention window.
   */
  private bound(blob: LedgerBlob): void {
    if (blob.entries.length > this.maxEntries) {
      const overflow = blob.entries.splice(0, blob.entries.length - this.maxEntries);
      for (const e of overflow) foldIntoRollups(blob.rollups, e);
    }
    const cutoff = new Date(this.now() - ROLLUP_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    blob.rollups = blob.rollups.filter((r) => r.day >= cutoff);
  }

  /** Compute the savings summary. Pure over the persisted ledger + price basis. */
  summary(opts?: { pricing?: PricingStore; table?: PricingTable }): SavingsSummary {
    const blob = this.read();
    const pricing = opts?.pricing ?? new PricingStore(this.kv);
    const basis = pricing.resolveBasis(opts?.table ?? PRESET_PRICING);
    return computeSavings(blob, basis);
  }

  /** Wipe the ledger (e.g. a user "reset savings"). */
  clear(): void {
    this.write(freshBlob());
  }
}

/** Fold an aged-out entry into the matching daily rollup bucket. */
function foldIntoRollups(rollups: DailyRollup[], e: LedgerEntry): void {
  if (e.target === "unroutable") return; // never billable; drop on fold
  const match = rollups.find(
    (r) =>
      r.day === e.day &&
      r.target === e.target &&
      r.model === e.model &&
      r.tokens_source === e.tokens_source,
  );
  // Rollups carry effective (backfilled) counts so summing survives the fold.
  const tin = e.completed ? effectiveTokensIn(e) : 0;
  const tout = e.completed ? e.tokens_out ?? 0 : 0;
  if (match) {
    match.tokens_in += tin;
    match.tokens_out += tout;
    match.count += 1;
  } else {
    rollups.push({
      day: e.day,
      target: e.target,
      model: e.model,
      tokens_source: e.tokens_source,
      tokens_in: tin,
      tokens_out: tout,
      count: 1,
    });
  }
}

/**
 * Savings = Σ over LOCAL, COMPLETED requests of
 *   (tokens_in × input_per_1m + tokens_out × output_per_1m) / 1e6
 * i.e. "what you WOULD have paid had these locally-served requests hit the API
 * instead" — priced at the user's chosen counterfactual server model (basis),
 * NOT the local model the request actually ran on.
 */
export function computeSavings(blob: LedgerBlob, basis: PriceBasis): SavingsSummary {
  const byDay = new Map<string, { saved: number; local_count: number; server_count: number }>();
  const bump = (day: string) => {
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = { saved: 0, local_count: 0, server_count: 0 }));
    return d;
  };
  const price = (tin: number, tout: number) =>
    (tin * basis.input_per_1m + tout * basis.output_per_1m) / 1e6;

  let total = 0;
  let localCount = 0;
  let serverCount = 0;
  let estimatedLocal = 0;

  // Raw entries.
  for (const e of blob.entries) {
    if (e.target === "local") {
      localCount += 1;
      if (e.tokens_source === "estimated") estimatedLocal += 1;
      const d = bump(e.day);
      d.local_count += 1;
      if (e.completed) {
        const saved = price(effectiveTokensIn(e), e.tokens_out ?? 0);
        total += saved;
        d.saved += saved;
      }
    } else if (e.target === "server") {
      serverCount += 1;
      bump(e.day).server_count += 1;
    }
  }

  // Rollups (already effective/backfilled, completed-only at fold time).
  for (const r of blob.rollups) {
    if (r.target === "local") {
      localCount += r.count;
      if (r.tokens_source === "estimated") estimatedLocal += r.count;
      const d = bump(r.day);
      d.local_count += r.count;
      const saved = price(r.tokens_in, r.tokens_out);
      total += saved;
      d.saved += saved;
    } else if (r.target === "server") {
      serverCount += r.count;
      bump(r.day).server_count += r.count;
    }
  }

  const by_day = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  return {
    total_saved: total,
    currency: "USD",
    by_day,
    local_count: localCount,
    server_count: serverCount,
    total_requests: localCount + serverCount,
    estimated_fraction: localCount === 0 ? 0 : estimatedLocal / localCount,
    pricing_basis: {
      model: basis.model,
      input_per_1m: basis.input_per_1m,
      output_per_1m: basis.output_per_1m,
      price_as_of: basis.price_as_of,
      source: basis.source,
      verified: basis.verified,
      overridden: basis.overridden,
    },
  };
}
