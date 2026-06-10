import { describe, expect, it } from "vitest";
import { BenchStore, type KV } from "../src/state";

function makeKv(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("BenchStore state machine", () => {
  it("round-trips state and walks the queue", () => {
    const store = new BenchStore(makeKv());
    let state = store.newState("test-device");
    state = store.enqueue(state, ["webllm", "wllama"], ["qwen2.5-1.5b"], "cold");
    expect(state.queue).toHaveLength(2);

    const first = store.nextPending(state);
    expect(first?.engine).toBe("webllm");
    store.markSession(state, first!, "done");

    // Simulate reload: re-read from storage
    const reloaded = store.loadState();
    expect(reloaded).not.toBeNull();
    expect(store.nextPending(reloaded!)?.engine).toBe("wllama");
  });

  it("preserves model run order (iPhone protocol: llama first)", () => {
    const store = new BenchStore(makeKv());
    const state = store.enqueue(
      store.newState(""),
      ["webllm"],
      ["llama-3.2-1b", "qwen2.5-1.5b"],
      "warm",
    );
    expect(state.queue.map((q) => q.modelKey)).toEqual(["llama-3.2-1b", "qwen2.5-1.5b"]);
  });

  it("converts a surviving tombstone into a probable_oom_tab_kill error row and aborts the session", () => {
    const store = new BenchStore(makeKv());
    let state = store.enqueue(
      store.newState("iphone"),
      ["webllm", "transformersjs"],
      ["qwen2.5-1.5b"],
      "warm",
    );
    // generate() started, tombstone written…
    store.writeTombstone({
      stage: "generate",
      engine: "webllm",
      engineVersion: "0.2.84",
      backend: "webgpu",
      modelKey: "qwen2.5-1.5b",
      modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      quant: "q4f16_1",
      prompt: "long-context",
      cacheState: "warm",
      startedAt: new Date().toISOString(),
      kvContextWindow: 2048,
      prefillChunk: 1024,
    });
    // …and the tab was killed. Page reloads:
    state = store.loadState()!;
    const recovered = store.recoverTombstone(state);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.error?.error_name).toBe("probable_oom_tab_kill");
    expect(recovered[0]!.error?.stage).toBe("generate");
    expect(recovered[0]!.prompt).toBe("long-context");
    // The OOM-kill row records the KV condition it died under.
    expect(recovered[0]!.kv_context_window).toBe(2048);
    expect(recovered[0]!.prefill_chunk).toBe(1024);
    // The webllm session is aborted, not retried in a loop…
    expect(state.queue[0]!.status).toBe("aborted");
    // …and the next engine is still runnable.
    expect(store.nextPending(state)?.engine).toBe("transformersjs");
    // Tombstone is consumed exactly once.
    expect(store.recoverTombstone(state)).toEqual([]);
    // The row is persisted.
    expect(store.loadState()!.runs).toHaveLength(1);
  });

  it("converts a surviving init-stage tombstone into error rows for every prompt and advances the plan", () => {
    const store = new BenchStore(makeKv());
    let state = store.enqueue(
      store.newState("iphone"),
      ["webllm", "transformersjs"],
      ["qwen2.5-1.5b"],
      "cold",
    );
    // Session open, load() started, init tombstone written…
    store.appendSession(state, {
      engine: "webllm",
      model_id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      cache_state: "cold",
      started_at: new Date().toISOString(),
      ended_at: null,
      battery_start: null,
      battery_end: null,
    });
    store.writeTombstone({
      stage: "init",
      engine: "webllm",
      engineVersion: "0.2.84",
      backend: null,
      modelKey: "qwen2.5-1.5b",
      modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      quant: "q4f16_1",
      prompt: null,
      cacheState: "cold",
      startedAt: new Date().toISOString(),
      kvContextWindow: null,
      prefillChunk: null,
    });
    // …and the tab was killed mid-download. Page reloads:
    state = store.loadState()!;
    const recovered = store.recoverTombstone(state);

    // One error row per prompt (same shape as an explicit load failure).
    expect(recovered).toHaveLength(2);
    expect(recovered.map((r) => r.prompt).sort()).toEqual(["long-context", "short"]);
    for (const row of recovered) {
      expect(row.error?.error_name).toBe("probable_oom_tab_kill");
      expect(row.error?.stage).toBe("init");
      expect(row.error?.error_message).toContain("never reached ready");
    }
    // Session aborted — no infinite retry loop…
    expect(state.queue[0]!.status).toBe("aborted");
    // …the dangling session row is closed…
    expect(state.sessions[0]!.ended_at).not.toBeNull();
    // …and the next engine is still runnable.
    expect(store.nextPending(state)?.engine).toBe("transformersjs");
    // Tombstone is consumed exactly once.
    expect(store.recoverTombstone(state)).toEqual([]);
    expect(store.loadState()!.runs).toHaveLength(2);
  });

  it("clearTombstone after successful generate leaves nothing to recover", () => {
    const store = new BenchStore(makeKv());
    const state = store.enqueue(store.newState(""), ["wllama"], ["llama-3.2-1b"], "cold");
    store.writeTombstone({
      stage: "generate",
      engine: "wllama",
      engineVersion: "3.4.1",
      backend: "wasm-singlethread",
      modelKey: "llama-3.2-1b",
      modelId: "bartowski/Llama-3.2-1B-Instruct-GGUF",
      quant: "Q4_K_M",
      prompt: "short",
      cacheState: "cold",
      startedAt: new Date().toISOString(),
      kvContextWindow: 4096,
      prefillChunk: null,
    });
    store.clearTombstone();
    expect(store.recoverTombstone(state)).toEqual([]);
    expect(state.runs).toHaveLength(0);
  });
});
