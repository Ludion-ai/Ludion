import { describe, expect, it } from "vitest";
import type { PriceBasis } from "ludion-router/savings";
import { projectOverviewData, type ProjectAggregate } from "./project";

const BASIS: PriceBasis = {
  model: "test-basis",
  label: "Test basis",
  input_per_1m: 3,
  output_per_1m: 15,
  price_as_of: "2026-06",
  source: "test",
  verified: false,
  overridden: false,
};

function agg(overrides: Partial<ProjectAggregate> = {}): ProjectAggregate {
  return {
    schema: "ludion.decisions.aggregate.v0",
    projectId: "ludion-dogfood-1",
    updated_at: "2026-06-22T00:00:00.000Z",
    routed: 0,
    on_device: 0,
    fallback: 0,
    success: 0,
    error: 0,
    saved_tokens_in: 0,
    saved_tokens_out: 0,
    by_model: {},
    recent: [],
    ...overrides,
  };
}

describe("projectOverviewData", () => {
  it("prices cumulative token sums into an exact summary (computeSavings reuse)", () => {
    const data = projectOverviewData(
      agg({
        routed: 3,
        on_device: 2,
        fallback: 1,
        success: 3,
        saved_tokens_in: 100,
        saved_tokens_out: 50,
      }),
      BASIS,
      null,
      "subtitle",
    );
    expect(data.summary.local_count).toBe(2);
    expect(data.summary.server_count).toBe(1);
    // (100*3 + 50*15) / 1e6
    expect(data.summary.total_saved).toBeCloseTo(0.00105, 10);
    expect(data.summary.pricing_basis.model).toBe("test-basis");
    expect(data.subtitle).toBe("subtitle");
  });

  it("maps recent rows to ledger entries (route → target, error → not completed)", () => {
    const data = projectOverviewData(
      agg({
        recent: [
          { t: 1_700_000_000_000, model: "qwen2.5-0.5b", route: "local", tokens_in: 10, tokens_out: 20 },
          { t: 1_700_000_001_000, model: "claude-haiku", route: "fallback", tokens_in: 5, tokens_out: 7 },
          { t: 1_700_000_002_000, model: "claude-haiku", route: "error", tokens_in: null, tokens_out: null },
        ],
      }),
      BASIS,
      null,
      "subtitle",
    );
    expect(data.snapshot.rollups).toEqual([]);
    const [local, server, err] = data.snapshot.entries;
    expect(local!.target).toBe("local");
    expect(local!.completed).toBe(true);
    expect(local!.tokens_source).toBe("exact");
    expect(local!.rule_id).toBe("—");
    expect(server!.target).toBe("server");
    expect(err!.target).toBe("unroutable");
    expect(err!.completed).toBe(false);
    expect(err!.tokens_source).toBe("estimated");
  });

  it("yields an empty-but-valid summary for a project with no decisions", () => {
    const data = projectOverviewData(agg(), BASIS, null, "subtitle");
    expect(data.summary.local_count).toBe(0);
    expect(data.summary.server_count).toBe(0);
    expect(data.summary.total_saved).toBe(0);
    expect(data.snapshot.entries).toEqual([]);
  });
});
