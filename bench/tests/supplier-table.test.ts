import { describe, expect, it } from "vitest";
import { buildSupplierTable, type SupplierInput } from "../src/supplier-table";
import type { BenchDocument, RunRow } from "../src/schema";

function run(overrides: Partial<RunRow>): RunRow {
  return {
    engine: "webllm",
    engine_version: "0.2.84",
    backend: "webgpu",
    model_id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    quant: "q4f16_1",
    prompt: "short",
    cache_state: "warm",
    download_ms: null,
    download_mb: null,
    init_ms: null,
    ttft_ms: 400,
    prefill_tps: 50,
    decode_tps: 10,
    tokens_in: 30,
    tokens_out: 128,
    token_count_source: "engine",
    timing_source: "estimated",
    peak_mem_mb: null,
    kv_context_window: 2048,
    prefill_chunk: 1024,
    error: null,
    ...overrides,
  };
}

function doc(runs: RunRow[]): BenchDocument {
  return {
    schema: "entelic.bench.v0",
    collected_at: "2026-06-10T19:00:00.000Z",
    device: {
      ua: "test",
      webgpu: true,
      adapter: null,
      hw_concurrency: 6,
      device_memory_gb: null,
      screen: "390x844@3",
      operator_label: "test",
    },
    sessions: [],
    runs,
    operator_notes: "",
  };
}

describe("buildSupplierTable", () => {
  it("computes per-group medians and marks error-only groups with ×", () => {
    const inputs: SupplierInput[] = [
      {
        device: "iphone-11-pro-max",
        file: "iphone-11-pro-max-20260610T190000.json",
        doc: doc([
          // 3 timed ok runs -> medians 11 / 51 / 410
          run({ decode_tps: 10, prefill_tps: 50, ttft_ms: 400 }),
          run({ decode_tps: 11, prefill_tps: 51, ttft_ms: 410 }),
          run({ decode_tps: 12, prefill_tps: 52, ttft_ms: 420 }),
          // error-only group: Llama OOM-killed mid-generate (routing-table data)
          run({
            model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
            decode_tps: null,
            prefill_tps: null,
            ttft_ms: null,
            error: {
              stage: "generate",
              error_name: "probable_oom_tab_kill",
              error_message: "page reloaded mid-generation",
            },
          }),
        ]),
      },
    ];

    const md = buildSupplierTable(inputs);

    expect(md).toContain(
      "| iphone-11-pro-max | webllm | Qwen2.5-0.5B-Instruct-q4f16_1-MLC | short | warm | webgpu | 11 | 51 | 410 | 0/3 (0%) | 2048/1024 |",
    );
    // Error-only group is present, marked ×, error rate 100%, kv condition kept.
    const llamaLine = md.split("\n").find((l) => l.includes("Llama-3.2-1B"));
    expect(llamaLine).toBeDefined();
    expect(llamaLine).toContain("× webgpu");
    expect(llamaLine).toContain("| × | × | × |");
    expect(llamaLine).toContain("1/1 (100%)");
    expect(llamaLine).toContain("2048/1024");
  });

  it("renders missing kv fields (pre-amendment exports) as – and lists warnings", () => {
    const legacy = run({}) as unknown as Record<string, unknown>;
    delete legacy.kv_context_window;
    delete legacy.prefill_chunk;
    const md = buildSupplierTable(
      [{ device: "desktop-chrome", file: "desktop-chrome-20260601T120000.json", doc: doc([legacy as unknown as RunRow]) }],
      ["`desktop-chrome-20260601T120000.json`: 2 schema deviation(s) — included anyway."],
    );
    expect(md).toContain("| –/– |");
    expect(md).toContain("## Validation warnings");
    expect(md).toContain("2 schema deviation(s)");
  });

  it("handles zero inputs", () => {
    const md = buildSupplierTable([]);
    expect(md).toContain("No runs found");
  });
});
