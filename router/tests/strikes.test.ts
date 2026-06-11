import { describe, expect, it } from "vitest";
import type { KV } from "../src/strikes";
import {
  DEFAULT_STRIKE_TTL_MS,
  STRIKE_CAUGHT,
  STRIKE_KILL,
  StrikeStore,
} from "../src/strikes";

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

function makeStore(ttl = DEFAULT_STRIKE_TTL_MS): { store: StrikeStore; kv: KV; tick: (ms: number) => void } {
  let t = 1_000_000_000_000;
  const kv = memKV();
  const store = new StrikeStore(kv, ttl, () => t);
  return { store, kv, tick: (ms) => (t += ms) };
}

describe("StrikeStore (Q5)", () => {
  it("accumulates: two caught failures (0.5) = one strike", () => {
    const { store } = makeStore();
    expect(store.isStruck(MODEL)).toBe(false);
    store.addStrike(MODEL, STRIKE_CAUGHT);
    expect(store.isStruck(MODEL)).toBe(false);
    store.addStrike(MODEL, STRIKE_CAUGHT);
    expect(store.getScore(MODEL)).toBe(1);
    expect(store.isStruck(MODEL)).toBe(true);
  });

  it("TTL expiry restores eligibility (lazy eviction on read; acceptance 4)", () => {
    const { store, tick } = makeStore();
    store.addStrike(MODEL, STRIKE_KILL);
    expect(store.isStruck(MODEL)).toBe(true);
    tick(DEFAULT_STRIKE_TTL_MS); // exactly at TTL: still struck
    expect(store.isStruck(MODEL)).toBe(true);
    tick(1); // past TTL
    expect(store.getScore(MODEL)).toBe(0);
    expect(store.isStruck(MODEL)).toBe(false);
  });

  it("configurable TTL", () => {
    const { store, tick } = makeStore(1000);
    store.addStrike(MODEL, STRIKE_KILL);
    tick(1001);
    expect(store.isStruck(MODEL)).toBe(false);
  });

  it("strikes are per model_id (localModel change naturally separates)", () => {
    const { store } = makeStore();
    store.addStrike(MODEL, STRIKE_KILL);
    expect(store.isStruck("Qwen2.5-0.5B-Instruct-q4f16_1-MLC")).toBe(false);
  });

  it("snapshot reflects scores for the decision log", () => {
    const { store } = makeStore();
    store.addStrike(MODEL, STRIKE_CAUGHT);
    expect(store.snapshot()).toEqual({ [MODEL]: 0.5 });
  });

  it("tombstone survives a 'reload' and converts to a kill strike (+1.0)", () => {
    const { store, kv } = makeStore();
    store.writeTombstone(MODEL, "generate");
    // simulate reload: a fresh store over the same kv
    const next = new StrikeStore(kv, DEFAULT_STRIKE_TTL_MS, Date.now);
    const t = next.recoverTombstone();
    expect(t?.model_id).toBe(MODEL);
    expect(t?.stage).toBe("generate");
    expect(next.getScore(MODEL)).toBe(STRIKE_KILL);
    // tombstone is cleared: second recovery is a no-op
    expect(next.recoverTombstone()).toBeNull();
    expect(next.getScore(MODEL)).toBe(STRIKE_KILL);
  });

  it("cleared tombstone (normal completion) adds nothing", () => {
    const { store, kv } = makeStore();
    store.writeTombstone(MODEL, "load");
    store.clearTombstone();
    const next = new StrikeStore(kv, DEFAULT_STRIKE_TTL_MS, Date.now);
    expect(next.recoverTombstone()).toBeNull();
    expect(next.getScore(MODEL)).toBe(0);
  });

  it("corrupted persisted JSON degrades to a fresh store", () => {
    const { store, kv } = makeStore();
    kv.setItem("ludion.router.strikes.v1", "{not json");
    kv.setItem("ludion.router.tombstone.v1", "also not json");
    expect(store.getScore(MODEL)).toBe(0);
    expect(store.readTombstone()).toBeNull();
    store.addStrike(MODEL, STRIKE_KILL); // recovers by overwriting
    expect(store.isStruck(MODEL)).toBe(true);
  });

  it("B-5: a throwing KV never propagates (absolute no-throw guarantee)", () => {
    const throwing: KV = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    const store = new StrikeStore(throwing, DEFAULT_STRIKE_TTL_MS, Date.now);
    expect(() => {
      store.addStrike(MODEL, STRIKE_KILL);
      store.getScore(MODEL);
      store.writeTombstone(MODEL, "generate");
      store.recoverTombstone();
      store.snapshot();
      store.clearTombstone();
    }).not.toThrow();
  });
});
