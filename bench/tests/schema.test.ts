import { describe, expect, it } from "vitest";
import { validateBenchDocument, type BenchDocument, type RunRow } from "../src/schema";

function validRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    engine: "webllm",
    engine_version: "0.2.84",
    backend: "webgpu",
    model_id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    quant: "q4f16_1",
    prompt: "short",
    cache_state: "cold",
    download_ms: 12000,
    download_mb: 869,
    init_ms: 3000,
    ttft_ms: 450,
    prefill_tps: 80.2,
    decode_tps: 21.4,
    tokens_in: 36,
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

function validDoc(): BenchDocument {
  return {
    schema: "ludion.bench.v0",
    collected_at: new Date().toISOString(),
    device: {
      ua: "test-agent",
      webgpu: true,
      adapter: {
        vendor: "apple",
        architecture: "common-3",
        f16: true,
        maxBufferSize: 4294967296,
        limitsRaw: { maxBufferSize: 4294967296 },
      },
      hw_concurrency: 8,
      device_memory_gb: null,
      screen: "390x844@3",
      operator_label: "iPhone 15",
    },
    sessions: [
      {
        engine: "webllm",
        model_id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
        cache_state: "cold",
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        battery_start: 0.93,
        battery_end: 0.88,
      },
    ],
    runs: [validRun()],
    operator_notes: "",
  };
}

describe("validateBenchDocument", () => {
  it("accepts a fully populated document", () => {
    const result = validateBenchDocument(validDoc());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts null adapter and error rows with null metrics", () => {
    const doc = validDoc();
    doc.device.adapter = null;
    doc.device.webgpu = false;
    doc.runs.push(
      validRun({
        backend: null,
        download_ms: null,
        download_mb: null,
        init_ms: null,
        ttft_ms: null,
        prefill_tps: null,
        decode_tps: null,
        tokens_in: null,
        tokens_out: null,
        token_count_source: null,
        timing_source: null,
        error: {
          stage: "generate",
          error_name: "probable_oom_tab_kill",
          error_message: "page reloaded mid-generation",
        },
      }),
    );
    expect(validateBenchDocument(doc).ok).toBe(true);
  });

  it("accepts the legacy schema id (archived Gate 0 exports)", () => {
    const doc = validDoc();
    doc.schema = "entelic.bench.v0";
    const result = validateBenchDocument(doc);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects wrong schema id", () => {
    const doc = validDoc() as unknown as Record<string, unknown>;
    for (const bad of ["ludion.bench.v1", "entelic.bench.v1"]) {
      doc.schema = bad;
      const result = validateBenchDocument(doc);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("$.schema"))).toBe(true);
    }
  });

  it("rejects invalid backend enum value", () => {
    const doc = validDoc();
    (doc.runs[0] as unknown as Record<string, unknown>).backend = "wasm"; // not in 3-value enum
    const result = validateBenchDocument(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("backend"))).toBe(true);
  });

  it("rejects missing fields and non-finite numbers", () => {
    const doc = validDoc();
    const run = doc.runs[0] as unknown as Record<string, unknown>;
    delete run.ttft_ms;
    run.decode_tps = Number.NaN;
    const result = validateBenchDocument(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ttft_ms: missing"))).toBe(true);
    expect(result.errors.some((e) => e.includes("decode_tps"))).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateBenchDocument("[]").ok).toBe(false);
    expect(validateBenchDocument(null).ok).toBe(false);
  });
});
