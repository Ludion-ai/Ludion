import { describe, expect, it } from "vitest";
import type { LedgerEntry, SavingsSummary } from "ludion-router/savings";
import {
  dailySeries,
  hasData,
  overviewStats,
  recentDecisions,
  resolveModel,
  topModelsByShare,
  type Snapshot,
} from "./shape";

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

function summary(over: Partial<SavingsSummary>): SavingsSummary {
  return {
    total_saved: 0,
    currency: "USD",
    by_day: [],
    local_count: 0,
    server_count: 0,
    total_requests: 0,
    estimated_fraction: 0,
    pricing_basis: {
      model: "gpt-4o",
      input_per_1m: 2.5,
      output_per_1m: 10,
      price_as_of: "2026-06",
      source: "test",
      verified: false,
      overridden: false,
    },
    ...over,
  };
}

describe("hasData", () => {
  it("is false for an empty snapshot and true once anything is recorded", () => {
    expect(hasData({ entries: [], rollups: [] })).toBe(false);
    expect(hasData({ entries: [entry({})], rollups: [] })).toBe(true);
    expect(
      hasData({
        entries: [],
        rollups: [
          { day: "2026-06-15", target: "local", model: "m", tokens_source: "exact", tokens_in: 1, tokens_out: 1, count: 1 },
        ],
      }),
    ).toBe(true);
  });
});

describe("resolveModel — registry join", () => {
  it("matches a local entry by its WebLLM id", () => {
    const m = resolveModel("Llama-3.2-1B-Instruct-q4f16_1-MLC");
    expect(m?.display_name).toBe("Llama-3.2-1B-Instruct");
    expect(m?.kind).toBe("local");
  });

  it("matches an api entry by canonical id", () => {
    expect(resolveModel("gpt-4o-mini")?.display_name).toBe("GPT-4o-mini");
  });

  it("returns undefined for an unknown model string (no fabrication)", () => {
    expect(resolveModel("ghost-model")).toBeUndefined();
  });
});

describe("overviewStats", () => {
  it("derives routed counts from the summary and success from entries", () => {
    const snap: Snapshot = {
      entries: [entry({}), entry({ completed: false }), entry({ target: "server" })],
      rollups: [],
    };
    const s = overviewStats(snap, summary({ local_count: 2, server_count: 1 }));
    expect(s.routed).toBe(3);
    expect(s.local).toBe(2);
    expect(s.server).toBe(1);
    expect(s.localPct).toBeCloseTo((2 / 3) * 100, 6);
    expect(s.successRate).toBeCloseTo(2 / 3, 6); // 2 of 3 entries completed
  });

  it("returns null success rate and zero shares when there is nothing", () => {
    const s = overviewStats({ entries: [], rollups: [] }, summary({}));
    expect(s.successRate).toBeNull();
    expect(s.localPct).toBe(0);
    expect(s.routed).toBe(0);
  });
});

describe("topModelsByShare", () => {
  it("counts per model (entries + rollups), labels via registry, sorts by count", () => {
    const snap: Snapshot = {
      entries: [
        entry({ model: "Llama-3.2-1B-Instruct-q4f16_1-MLC" }),
        entry({ model: "Llama-3.2-1B-Instruct-q4f16_1-MLC" }),
        entry({ model: "gpt-4o-mini", target: "server" }),
        entry({ model: "x", target: "unroutable" }), // excluded from share
      ],
      rollups: [
        { day: "2026-06-14", target: "local", model: "Llama-3.2-1B-Instruct-q4f16_1-MLC", tokens_source: "exact", tokens_in: 1, tokens_out: 1, count: 1 },
      ],
    };
    const top = topModelsByShare(snap);
    expect(top[0]!.label).toBe("Llama-3.2-1B-Instruct");
    expect(top[0]!.count).toBe(3); // 2 entries + 1 rollup
    expect(top[0]!.status).toBe("on-device");
    expect(top[1]!.label).toBe("GPT-4o-mini");
    expect(top[1]!.status).toBe("verified");
    // shares sum to 1 across the 4 counted requests (unroutable excluded).
    const total = top.reduce((n, m) => n + m.count, 0);
    expect(total).toBe(4);
    expect(top[0]!.share).toBeCloseTo(3 / 4, 6);
  });

  it("keeps the raw id and null status for an unknown model", () => {
    const top = topModelsByShare({ entries: [entry({ model: "ghost" })], rollups: [] });
    expect(top[0]!.label).toBe("ghost");
    expect(top[0]!.status).toBeNull();
  });
});

describe("dailySeries — per-day chart data from summary.by_day", () => {
  it("splits routed/local/saved per day in by_day order", () => {
    const s = dailySeries(
      summary({
        by_day: [
          { day: "2026-06-13", saved: 0.5, local_count: 2, server_count: 1 },
          { day: "2026-06-14", saved: 1.25, local_count: 3, server_count: 0 },
        ],
      }),
    );
    expect(s.days).toEqual(["2026-06-13", "2026-06-14"]);
    expect(s.routed).toEqual([3, 3]); // local + server
    expect(s.local).toEqual([2, 3]);
    expect(s.saved).toEqual([0.5, 1.25]);
  });

  it("is all-empty arrays when there is no day data (drives the skeletons)", () => {
    const s = dailySeries(summary({}));
    expect(s.days).toEqual([]);
    expect(s.routed).toEqual([]);
    expect(s.local).toEqual([]);
    expect(s.saved).toEqual([]);
  });
});

describe("recentDecisions", () => {
  it("returns newest-first rows with real fields only", () => {
    const snap: Snapshot = {
      entries: [
        entry({ ts: "2026-06-15T10:00:00.000Z", rule_id: "R1" }),
        entry({ ts: "2026-06-15T11:00:00.000Z", rule_id: "R4", target: "server", model: "gpt-4o-mini" }),
      ],
      rollups: [],
    };
    const rows = recentDecisions(snap);
    expect(rows[0]!.ts).toBe("2026-06-15T11:00:00.000Z"); // newest first
    expect(rows[0]!.routing).toBe("fallback");
    expect(rows[0]!.model).toBe("GPT-4o-mini");
    expect(rows[0]!.rule).toBe("R4");
    expect(rows[1]!.routing).toBe("on-device");
  });

  it("respects the limit", () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry({ ts: `2026-06-15T${i}:00:00.000Z` }));
    expect(recentDecisions({ entries, rollups: [] }, 5)).toHaveLength(5);
  });
});
