import { describe, expect, it } from "vitest";
import { runSession } from "../src/harness";
import { BenchStore, type KV } from "../src/state";
import { getModel } from "../src/models";
import type { BenchAdapter } from "../src/adapters/types";
import { buildDocument } from "../src/export";
import { validateBenchDocument, type DeviceInfo } from "../src/schema";

function makeKv(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failingAdapter(): BenchAdapter {
  return {
    id: "webllm",
    version: () => "test",
    load: () => Promise.reject(new Error("Cannot find model record: bogus-model-id")),
    generate: () => Promise.reject(new Error("unreachable")),
    unload: () => Promise.resolve(),
  };
}

function workingAdapter(): BenchAdapter {
  return {
    id: "wllama",
    version: () => "test",
    load: async (_model, onProgress) => {
      const total = 100 * 1024 * 1024; // 100 MiB
      onProgress({ kind: "download", loadedBytes: total / 2, totalBytes: total, approxMb: null, text: "half" });
      await delay(5);
      onProgress({ kind: "download", loadedBytes: total, totalBytes: total, approxMb: null, text: "full" });
      await delay(5);
      return { backend: "wasm-singlethread" as const, timingSource: "engine" as const };
    },
    generate: async (_req, onToken) => {
      for (let i = 0; i < 4; i++) {
        await delay(2);
        onToken({ textDelta: "tok " });
      }
      return { text: "tok tok tok tok ", tokensIn: 40, tokensOut: 4, tokenCountSource: "engine" as const };
    },
    unload: () => Promise.resolve(),
  };
}

const device: DeviceInfo = {
  ua: "test",
  webgpu: false,
  adapter: null,
  hw_concurrency: 4,
  device_memory_gb: null,
  screen: "0x0@1",
  operator_label: "ci",
};

const hooks = { log: () => {}, onProgress: () => {}, onRow: () => {} };

describe("runSession (acceptance criterion 4: induced failure isolates)", () => {
  it("records error rows for a bogus model and leaves other engines runnable; export stays valid", async () => {
    const store = new BenchStore(makeKv());
    const state = store.enqueue(store.newState("ci"), ["webllm", "wllama"], ["qwen2.5-1.5b"], "warm");
    const spec = getModel("qwen2.5-1.5b");

    // Engine 1: induced failure (bogus model id)
    const failItem = store.nextPending(state)!;
    await runSession(store, state, failItem, failingAdapter(), spec, hooks);

    expect(failItem.status).toBe("aborted");
    const errorRows = state.runs.filter((r) => r.error !== null);
    expect(errorRows).toHaveLength(2); // one per prompt
    expect(errorRows.every((r) => r.error!.stage === "init")).toBe(true);
    expect(errorRows.every((r) => r.error!.error_message.includes("bogus-model-id"))).toBe(true);

    // Engine 2 is not blocked
    const nextItem = store.nextPending(state)!;
    expect(nextItem.engine).toBe("wllama");
    await runSession(store, state, nextItem, workingAdapter(), spec, hooks);
    expect(nextItem.status).toBe("done");

    // 2 error rows + 2 prompts × 3 timed runs
    expect(state.runs).toHaveLength(2 + 6);
    const okRows = state.runs.filter((r) => r.error === null);
    expect(okRows).toHaveLength(6);
    for (const row of okRows) {
      expect(row.backend).toBe("wasm-singlethread");
      expect(row.ttft_ms).not.toBeNull();
      expect(row.tokens_out).toBe(4);
      expect(row.decode_tps).not.toBeNull();
      expect(row.download_mb).toBe(100);
    }

    // Sessions recorded for both engines, both closed
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.every((s) => s.ended_at !== null)).toBe(true);

    // Partial/failed results still export to a valid document
    const doc = buildDocument(state, device);
    const result = validateBenchDocument(doc);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    // No tombstone left behind
    expect(store.readTombstone()).toBeNull();
  });
});
