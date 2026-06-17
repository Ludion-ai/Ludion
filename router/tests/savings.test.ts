import { describe, expect, it } from "vitest";
import type { KV } from "../src/strikes";
import type { DecisionLog } from "../src/types";
import {
  ROLLUP_RETENTION_DAYS,
  SavingsLedger,
  computeSavings,
} from "../src/savings";
import type { LedgerEntry } from "../src/savings";
import { PRESET_PRICING, PricingStore } from "../src/pricing";
import type { PriceBasis } from "../src/pricing";

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** Minimal valid-enough DecisionLog for the ledger (it reads counts/meta only). */
function log(over: Partial<DecisionLog>): DecisionLog {
  return {
    policy_version: "v0",
    rule_id: "R4",
    target: "local",
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    privacy: false,
    stream: true,
    est_prompt_tokens: 10,
    max_tokens: 256,
    local_context_window: 4096,
    strike_state: {},
    probe: {} as DecisionLog["probe"],
    decided_at: "2026-06-15T10:00:00.000Z",
    completed: true,
    degraded: null,
    degraded_failed: false,
    cancelled: false,
    ttft_ms: 100,
    tps: 20,
    tokens_in: 100,
    tokens_out: 50,
    tokens_source: "exact",
    error: null,
    ...over,
  };
}

/** A LedgerEntry fixture for direct computeSavings tests. */
function entry(over: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: "2026-06-15T10:00:00.000Z",
    day: "2026-06-15",
    target: "local",
    rule_id: "R4",
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    tokens_in: 100,
    tokens_out: 50,
    tokens_source: "exact",
    est_prompt_tokens: 10,
    completed: true,
    ...over,
  };
}

// A fixed, hand-checkable price basis (acceptance #2).
const BASIS: PriceBasis = {
  model: "gpt-4o",
  label: "GPT-4o",
  input_per_1m: 2.5,
  output_per_1m: 10.0,
  price_as_of: "2026-06",
  source: "test",
  verified: false,
  overridden: false,
};

describe("computeSavings — hand-checked fixture (acceptance #2)", () => {
  it("prices local-completed entries at the counterfactual model", () => {
    // 1000 input × $2.5/1M + 200 output × $10/1M
    //   = 0.0025 + 0.002 = 0.0045 USD
    const blob = {
      version: 1 as const,
      entries: [entry({ tokens_in: 1000, tokens_out: 200 })],
      rollups: [],
    };
    const s = computeSavings(blob, BASIS);
    expect(s.total_saved).toBeCloseTo(0.0045, 12);
    expect(s.local_count).toBe(1);
    expect(s.server_count).toBe(0);
    expect(s.total_requests).toBe(1);
    expect(s.estimated_fraction).toBe(0);
    expect(s.pricing_basis.model).toBe("gpt-4o");
  });

  it("ignores server entries and incomplete local entries in the total", () => {
    const blob = {
      version: 1 as const,
      entries: [
        entry({ tokens_in: 1000, tokens_out: 200 }), // counted: 0.0045
        entry({ target: "server", tokens_in: 9999, tokens_out: 9999 }), // not counted
        entry({ completed: false, tokens_in: 1000, tokens_out: 200 }), // local but incomplete
      ],
      rollups: [],
    };
    const s = computeSavings(blob, BASIS);
    expect(s.total_saved).toBeCloseTo(0.0045, 12);
    expect(s.local_count).toBe(2); // both local entries count toward count
    expect(s.server_count).toBe(1);
    expect(s.total_requests).toBe(3);
  });

  it("prices the chosen counterfactual model, NOT the local model that ran", () => {
    const blob = {
      version: 1 as const,
      entries: [entry({ model: "some-tiny-local", tokens_in: 1_000_000, tokens_out: 0 })],
      rollups: [],
    };
    // 1M input tokens × $2.5/1M = exactly $2.50, regardless of local model id.
    expect(computeSavings(blob, BASIS).total_saved).toBeCloseTo(2.5, 9);
  });
});

describe("estimated vs exact (acceptance #3)", () => {
  it("backfills estimated entries from est_prompt_tokens and reports the fraction", () => {
    const blob = {
      version: 1 as const,
      entries: [
        entry({ tokens_source: "exact", tokens_in: 1000, tokens_out: 200 }),
        // estimated: tokens_in null → backfill from est_prompt_tokens (800)
        entry({ tokens_source: "estimated", tokens_in: null, est_prompt_tokens: 800, tokens_out: 100 }),
      ],
      rollups: [],
    };
    const s = computeSavings(blob, BASIS);
    // exact: 0.0025 + 0.002 = 0.0045
    // estimated: 800×2.5/1M + 100×10/1M = 0.002 + 0.001 = 0.003
    expect(s.total_saved).toBeCloseTo(0.0075, 12);
    expect(s.estimated_fraction).toBeCloseTo(0.5, 12);
  });

  it("estimated_fraction is 0 when there are no local entries", () => {
    const blob = {
      version: 1 as const,
      entries: [entry({ target: "server", tokens_in: 100, tokens_out: 50 })],
      rollups: [],
    };
    expect(computeSavings(blob, BASIS).estimated_fraction).toBe(0);
  });
});

describe("SavingsLedger.record — privacy & persistence (acceptance #1)", () => {
  it("stores counts/metadata only — never content (structural)", () => {
    const kv = memKV();
    const ledger = new SavingsLedger(kv);
    ledger.record(log({ tokens_in: 100, tokens_out: 50 }));
    const raw = kv.getItem("ludion.savings.ledger.v1")!;
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    const entry = parsed.entries[0];
    expect(Object.keys(entry).sort()).toEqual(
      [
        "completed",
        "day",
        "est_prompt_tokens",
        "model",
        "rule_id",
        "target",
        "tokens_in",
        "tokens_out",
        "tokens_source",
        "ts",
      ].sort(),
    );
    // No content-bearing key anywhere (est_prompt_tokens is a count, allowed).
    const contentKey = /messages?|content|response|^prompt$|completion|text|^body$/i;
    for (const k of Object.keys(entry)) expect(k).not.toMatch(contentKey);
    expect(entry.day).toBe("2026-06-15");
  });

  it("never throws when the KV throws (fail-open)", () => {
    const throwingKV: KV = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new Error("boom");
      },
      removeItem: () => {
        throw new Error("boom");
      },
    };
    const ledger = new SavingsLedger(throwingKV);
    expect(() => ledger.record(log({}))).not.toThrow();
    expect(() => ledger.summary()).not.toThrow();
  });
});

describe("bounding & rollup (acceptance #5)", () => {
  // Use a small cap so the O(n) read+write per record stays fast; the bounding
  // logic is identical at MAX_ENTRIES.
  const CAP = 10;

  it("caps raw entries at the cap and folds the overflow into rollups", () => {
    const kv = memKV();
    const ledger = new SavingsLedger(kv, Date.now, CAP);
    for (let i = 0; i < CAP + 5; i++) {
      ledger.record(log({ tokens_in: 100, tokens_out: 50 }));
    }
    const blob = JSON.parse(kv.getItem("ludion.savings.ledger.v1")!);
    expect(blob.entries.length).toBe(CAP);
    // The 5 oldest folded into a single matching rollup bucket.
    const rolled = blob.rollups.reduce((n: number, r: { count: number }) => n + r.count, 0);
    expect(rolled).toBe(5);
  });

  it("total is preserved across the raw→rollup fold", () => {
    const kv = memKV();
    const ledger = new SavingsLedger(kv, Date.now, CAP);
    const N = CAP + 25;
    for (let i = 0; i < N; i++) ledger.record(log({ tokens_in: 1000, tokens_out: 200 }));
    const s = ledger.summary({ table: PRESET_PRICING });
    // Every one of N entries is local-completed; total counts all of them.
    expect(s.local_count).toBe(N);
    // Default basis = first preset row (gpt-4o, 2.5/10) → 0.0045 each.
    expect(s.total_saved).toBeCloseTo(N * 0.0045, 6);
  });

  it("prunes rollups beyond the retention window", () => {
    const kv = memKV();
    let t = Date.parse("2026-06-15T00:00:00.000Z");
    const ledger = new SavingsLedger(kv, () => t);
    // Seed a stale rollup directly, then trigger bound() via a record + overflow.
    const stale = new Date(t - (ROLLUP_RETENTION_DAYS + 10) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const blob = {
      version: 1,
      entries: [],
      rollups: [
        { day: stale, target: "local", model: "m", tokens_source: "exact", tokens_in: 1, tokens_out: 1, count: 1 },
      ],
    };
    kv.setItem("ludion.savings.ledger.v1", JSON.stringify(blob));
    ledger.record(log({})); // triggers bound() → prune
    const after = JSON.parse(kv.getItem("ludion.savings.ledger.v1")!);
    expect(after.rollups.find((r: { day: string }) => r.day === stale)).toBeUndefined();
  });
});

describe("PricingStore — override beats preset (acceptance #4)", () => {
  it("resolves the selected preset by id", () => {
    const store = new PricingStore(memKV());
    store.selectModel("claude-haiku");
    const basis = store.resolveBasis();
    expect(basis.model).toBe("claude-haiku");
    expect(basis.overridden).toBe(false);
    expect(basis.verified).toBe(true); // claude-haiku confirmed against the official page
  });

  it("a manual override takes precedence over any preset", () => {
    const store = new PricingStore(memKV());
    store.selectModel("gpt-4o");
    store.setOverride({ label: "Negotiated", input_per_1m: 1.0, output_per_1m: 3.0 });
    const basis = store.resolveBasis();
    expect(basis.model).toBe("custom");
    expect(basis.overridden).toBe(true);
    expect(basis.input_per_1m).toBe(1.0);
    expect(basis.output_per_1m).toBe(3.0);
  });

  it("clearing the override falls back to the preset", () => {
    const store = new PricingStore(memKV());
    store.selectModel("gpt-4o-mini");
    store.setOverride({ input_per_1m: 9, output_per_1m: 9 });
    store.setOverride(null);
    expect(store.resolveBasis().model).toBe("gpt-4o-mini");
  });

  it("defaults to the first preset row when nothing is selected", () => {
    const basis = new PricingStore(memKV()).resolveBasis();
    expect(basis.model).toBe(PRESET_PRICING.models[0]!.id);
  });
});

describe("pricing.json honesty (acceptance #4)", () => {
  it("every seed row is dated and sourced", () => {
    for (const row of PRESET_PRICING.models) {
      expect(row.price_as_of).toMatch(/^\d{4}(-\d{2})?$/);
      expect(row.source.length).toBeGreaterThan(0);
      expect(typeof row.verified).toBe("boolean");
      expect(row.input_per_1m).toBeGreaterThan(0);
      expect(row.output_per_1m).toBeGreaterThan(0);
    }
  });
});
