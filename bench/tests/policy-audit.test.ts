import { describe, expect, it } from "vitest";
import type { BenchDocument, RunRow, SessionRow } from "../src/schema";
import {
  buildCells,
  buildGapReport,
  decidePolicy,
  isOnDeviceSuccess,
  type AuditInput,
} from "../src/policy-audit";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36";
const IAB_UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 8a; wv) AppleWebKit/537.36 Chrome/148.0 Mobile Safari/537.36 Line/26.8.0/IAB";

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    engine: "webllm",
    engine_version: "0.2.84",
    backend: "webgpu",
    model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    quant: "q4f16_1",
    prompt: "short",
    cache_state: "cold",
    download_ms: null,
    download_mb: null,
    init_ms: null,
    ttft_ms: 100,
    prefill_tps: null,
    decode_tps: 20,
    tokens_in: null,
    tokens_out: 32,
    token_count_source: "engine",
    timing_source: "engine",
    peak_mem_mb: null,
    kv_context_window: null,
    prefill_chunk: null,
    error: null,
    ...overrides,
  };
}

function failRun(overrides: Partial<RunRow> = {}): RunRow {
  return run({
    ttft_ms: null,
    decode_tps: null,
    tokens_out: null,
    error: { stage: "init", error_name: "TypeError", error_message: "Load failed" },
    ...overrides,
  });
}

function doc(ua: string, runs: RunRow[], sessions: SessionRow[] = []): BenchDocument {
  return {
    schema: "ludion.bench.v0",
    collected_at: "2026-06-10T00:00:00.000Z",
    device: {
      ua,
      webgpu: true,
      adapter: null,
      hw_concurrency: 4,
      device_memory_gb: null,
      screen: "0x0@1",
      operator_label: "",
    },
    sessions,
    runs,
    operator_notes: "",
  };
}

function input(file: string, d: BenchDocument): AuditInput {
  return { file, doc: d };
}

describe("isOnDeviceSuccess", () => {
  it("is success when no error and a core metric is present", () => {
    expect(isOnDeviceSuccess(run({ ttft_ms: 50, decode_tps: null, tokens_out: null }))).toBe(true);
  });
  it("is not success when an error object is present", () => {
    expect(isOnDeviceSuccess(failRun())).toBe(false);
  });
  it("is not success when no core metric was reported", () => {
    expect(isOnDeviceSuccess(run({ ttft_ms: null, decode_tps: null, tokens_out: null }))).toBe(false);
  });
});

describe("decidePolicy mirrors policy.v0 base routing", () => {
  it("desktop + webgpu + short prompt → local (R4)", () => {
    expect(
      decidePolicy({ env: "browser", webgpu: true, os_class: "desktop", est_prompt_tokens: 52, max_tokens: 256, stream: true }),
    ).toEqual({ rule_id: "R4", target: "local" });
  });
  it("ios-webkit → server (R3) regardless of prompt", () => {
    expect(
      decidePolicy({ env: "browser", webgpu: true, os_class: "ios-webkit", est_prompt_tokens: 52, max_tokens: 256, stream: true }).target,
    ).toBe("server");
  });
  it("android short streamed → local (R5); android long-context → server (R6)", () => {
    expect(
      decidePolicy({ env: "browser", webgpu: true, os_class: "android-chromium", est_prompt_tokens: 52, max_tokens: 256, stream: true }),
    ).toEqual({ rule_id: "R5", target: "local" });
    expect(
      decidePolicy({ env: "browser", webgpu: true, os_class: "android-chromium", est_prompt_tokens: 1213, max_tokens: 256, stream: true }).target,
    ).toBe("server");
  });
  it("webview-iab → server (R1) even with webgpu true", () => {
    expect(
      decidePolicy({ env: "webview-iab", webgpu: true, os_class: "android-chromium", est_prompt_tokens: 52, max_tokens: 256, stream: true }),
    ).toEqual({ rule_id: "R1", target: "server" });
  });
});

describe("buildCells", () => {
  it("aggregates runs into device_class x model x prompt x cache cells", () => {
    const cells = buildCells([input("desktop-x.json", doc(DESKTOP_UA, [run(), run()]))]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.deviceClass).toBe("desktop");
    expect(cells[0]!.nSuccess).toBe(2);
    expect(cells[0]!.nFailure).toBe(0);
  });

  it("records verbatim failure modes (stage:error_name), never an invented taxonomy", () => {
    const cells = buildCells([
      input("ip.json", doc(IPHONE_UA, [failRun({ error: { stage: "init", error_name: "probable_oom_tab_kill", error_message: "x" } })])),
    ]);
    expect(cells[0]!.failureModes).toEqual(["init:probable_oom_tab_kill"]);
  });

  it("synthesizes a (none)-prompt tab-kill cell for a stalled session with no runs", () => {
    const session: SessionRow = {
      engine: "webllm",
      model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      cache_state: "cold",
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: null,
      battery_start: null,
      battery_end: null,
    };
    const cells = buildCells([input("iab.json", doc(IAB_UA, [], [session]))]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.deviceClass).toBe("webview-iab");
    expect(cells[0]!.prompt).toBe("(none)");
    expect(cells[0]!.tabKill).toBe(true);
  });
});

describe("buildGapReport sections", () => {
  it("flags an on-device failure that policy routes local as an uncovered failure (a)", () => {
    // Desktop normally routes local (R4); a failing desktop cell is therefore an
    // uncovered known-failure case under the current policy.
    const report = buildGapReport([input("desktop-fail.json", doc(DESKTOP_UA, [failRun()]))]);
    expect(report.uncoveredFailures).toHaveLength(1);
    expect(report.uncoveredFailures[0]!.verdict.target).toBe("local");
  });

  it("flags an on-device success routed to server as savings left on the table (c)", () => {
    const report = buildGapReport([
      input("android-long.json", doc(ANDROID_UA, [run({ prompt: "long-context" })])),
    ]);
    expect(report.successesRoutedToServer.map((a) => a.verdict.target)).toEqual(["server"]);
  });

  it("puts single-sample and mixed contexts into thin/ambiguous (d)", () => {
    const report = buildGapReport([input("one.json", doc(DESKTOP_UA, [run()]))]);
    expect(report.thinOrAmbiguous).toHaveLength(1);
  });

  it("clean iOS failures (R3 server) produce no uncovered-failure gap", () => {
    const report = buildGapReport([input("ip.json", doc(IPHONE_UA, [failRun(), failRun()]))]);
    expect(report.uncoveredFailures).toHaveLength(0);
  });
});
