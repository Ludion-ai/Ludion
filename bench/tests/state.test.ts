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
      engine: "webllm",
      engineVersion: "0.2.84",
      backend: "webgpu",
      modelKey: "qwen2.5-1.5b",
      modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      quant: "q4f16_1",
      prompt: "long-context",
      cacheState: "warm",
      startedAt: new Date().toISOString(),
    });
    // …and the tab was killed. Page reloads:
    state = store.loadState()!;
    const recovered = store.recoverTombstone(state);

    expect(recovered).not.toBeNull();
    expect(recovered!.error?.error_name).toBe("probable_oom_tab_kill");
    expect(recovered!.error?.stage).toBe("generate");
    expect(recovered!.prompt).toBe("long-context");
    // The webllm session is aborted, not retried in a loop…
    expect(state.queue[0]!.status).toBe("aborted");
    // …and the next engine is still runnable.
    expect(store.nextPending(state)?.engine).toBe("transformersjs");
    // Tombstone is consumed exactly once.
    expect(store.recoverTombstone(state)).toBeNull();
    // The row is persisted.
    expect(store.loadState()!.runs).toHaveLength(1);
  });

  it("clearTombstone after successful generate leaves nothing to recover", () => {
    const store = new BenchStore(makeKv());
    const state = store.enqueue(store.newState(""), ["wllama"], ["llama-3.2-1b"], "cold");
    store.writeTombstone({
      engine: "wllama",
      engineVersion: "3.4.1",
      backend: "wasm-singlethread",
      modelKey: "llama-3.2-1b",
      modelId: "bartowski/Llama-3.2-1B-Instruct-GGUF",
      quant: "Q4_K_M",
      prompt: "short",
      cacheState: "cold",
      startedAt: new Date().toISOString(),
    });
    store.clearTombstone();
    expect(store.recoverTombstone(state)).toBeNull();
    expect(state.runs).toHaveLength(0);
  });
});
