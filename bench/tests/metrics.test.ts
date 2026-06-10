import { describe, expect, it } from "vitest";
import { decodeTps, median, prefillTps, round } from "../src/metrics";

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("prefillTps", () => {
  it("computes tokens_in / ttft", () => {
    expect(prefillTps(100, 500)).toBe(200);
  });
  it("returns null on missing or non-positive inputs", () => {
    expect(prefillTps(null, 500)).toBeNull();
    expect(prefillTps(100, null)).toBeNull();
    expect(prefillTps(100, 0)).toBeNull();
  });
});

describe("decodeTps", () => {
  it("computes (tokens_out - 1) / decode interval", () => {
    // 128 tokens, first at t=1000, last at t=11000 → 127 tokens / 10s
    expect(decodeTps(128, 1000, 11000)).toBeCloseTo(12.7);
  });
  it("is null when tokens_out <= 1 (division-by-zero fix)", () => {
    expect(decodeTps(1, 1000, 1000)).toBeNull();
    expect(decodeTps(0, 1000, 2000)).toBeNull();
    expect(decodeTps(null, 1000, 2000)).toBeNull();
  });
  it("is null when the interval is non-positive", () => {
    expect(decodeTps(10, 2000, 2000)).toBeNull();
    expect(decodeTps(10, null, 2000)).toBeNull();
  });
});

describe("round", () => {
  it("rounds and passes null through", () => {
    expect(round(1.23456)).toBe(1.23);
    expect(round(1.23456, 0)).toBe(1);
    expect(round(null)).toBeNull();
  });
});
