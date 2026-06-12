import { describe, expect, it } from "vitest";
import { BenchStore, type KV } from "../src/state";

/**
 * Gate 2.7 acceptance 4 (decisions F-8): a device killed mid-bench must,
 * after reload-recovery, satisfy the completion condition that renders the
 * Submit card: nextPending === null && runs.length > 0. Failure rows are
 * first-class submissions.
 */

function memKV(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("one-click flow reaches Submit after a mid-bench tab kill", () => {
  it("generate-stage kill: recovery yields error row + empty queue (Submit reachable)", () => {
    const store = new BenchStore(memKV());
    const state = store.newState("test-device");
    store.enqueue(state, ["webllm"], ["qwen2.5-0.5b"], "cold");
    // Simulate the kill: tombstone written before generate, page died, reload.
    store.writeTombstone({
      stage: "generate",
      engine: "webllm",
      engineVersion: "0.2.84",
      backend: "webgpu",
      modelKey: "qwen2.5-0.5b",
      modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      quant: "q4f16_1",
      prompt: "short",
      cacheState: "cold",
      startedAt: new Date().toISOString(),
      kvContextWindow: 2048,
      prefillChunk: 2048,
    });

    const recovered = store.recoverTombstone(state);

    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered[0]!.error?.error_name).toBe("probable_oom_tab_kill");
    // The exact completion condition used by renderFlow():
    expect(store.nextPending(state)).toBeNull();
    expect(state.runs.length).toBeGreaterThan(0);
  });

  it("init-stage kill: same guarantee, one error row per prompt", () => {
    const store = new BenchStore(memKV());
    const state = store.newState("test-device");
    store.enqueue(state, ["webllm"], ["llama-3.2-1b"], "cold");
    store.writeTombstone({
      stage: "init",
      engine: "webllm",
      engineVersion: "0.2.84",
      backend: null,
      modelKey: "llama-3.2-1b",
      modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      quant: "q4f16_1",
      prompt: null,
      cacheState: "cold",
      startedAt: new Date().toISOString(),
      kvContextWindow: null,
      prefillChunk: null,
    });

    const recovered = store.recoverTombstone(state);

    expect(recovered).toHaveLength(2); // short + long-context
    expect(store.nextPending(state)).toBeNull();
    expect(state.runs.length).toBe(2);
  });

  it("submitted marker is additive: pre-2.7 states load unchanged", () => {
    const kv = memKV();
    const store = new BenchStore(kv);
    const state = store.newState("old-device");
    store.saveState(state); // no `submitted` field, version 1
    const loaded = store.loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.submitted).toBeUndefined();
    loaded!.submitted = { at: "2026-06-12T10:00:00.000Z", total: 5 };
    store.saveState(loaded!);
    expect(store.loadState()!.submitted).toEqual({ at: "2026-06-12T10:00:00.000Z", total: 5 });
  });
});
