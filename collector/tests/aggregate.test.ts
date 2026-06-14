import { describe, expect, it } from "vitest";
import {
  AGGREGATE_KV_KEY,
  computeAggregate,
  emptyAggregate,
  rebuildAggregate,
  type Aggregate,
} from "../src/aggregate";
import {
  handleRequest,
  type CollectorEnv,
  type ExecutionContextLike,
  type KVLike,
  type R2Like,
} from "../src/handler";
import type { BenchDocument, RunRow } from "../../bench/src/schema";

// --- in-memory bindings (mirrors handler.test.ts) ------------------------------

class MemKV implements KVLike {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

class MemR2 implements R2Like {
  objects = new Map<string, string>();
  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }
  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async list(): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }> {
    return { objects: [...this.objects.keys()].map((key) => ({ key })), truncated: false };
  }
}

interface TestEnv extends CollectorEnv {
  COLLECTOR_KV: MemKV;
  SUBMISSIONS: MemR2;
}

function makeEnv(): TestEnv {
  return {
    COLLECTOR_KV: new MemKV(),
    SUBMISSIONS: new MemR2(),
    ALLOWED_ORIGINS: "https://ludion-bench.pages.dev,https://ludion-demo.pages.dev",
    IP_HASH_SALT: "test-salt",
    ADMIN_TOKEN: "test-token",
  };
}

/** A ctx whose waitUntil promises can be awaited (to drain the amortized rebuild). */
function drainCtx(): ExecutionContextLike & { settled: Promise<unknown> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>): void {
      pending.push(p);
    },
    get settled(): Promise<unknown> {
      return Promise.all(pending);
    },
  };
}

// --- document/run factories ----------------------------------------------------

const UA = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile Safari/604.1",
  fbiab:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 [FBAN/EMA;FBAV/1.0]",
} as const;

function okRun(decode: number | null, prefill: number | null): RunRow {
  return {
    engine: "webllm",
    engine_version: "0.2.0",
    backend: "webgpu",
    model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    quant: "q4f16_1",
    prompt: "short",
    cache_state: "cold",
    download_ms: 1000,
    download_mb: 700,
    init_ms: 500,
    ttft_ms: 100,
    prefill_tps: prefill,
    decode_tps: decode,
    tokens_in: 16,
    tokens_out: 64,
    token_count_source: "engine",
    timing_source: "engine",
    peak_mem_mb: 800,
    kv_context_window: 2048,
    prefill_chunk: null,
    error: null,
  };
}

function failRun(stage: "download" | "init" | "generate", errorName: string): RunRow {
  return {
    engine: "webllm",
    engine_version: "0.2.0",
    backend: null,
    model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    quant: "q4f16_1",
    prompt: "short",
    cache_state: "cold",
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
    peak_mem_mb: null,
    kv_context_window: null,
    prefill_chunk: null,
    error: { stage, error_name: errorName, error_message: "x" },
  };
}

function doc(ua: string, webgpu: boolean, runs: RunRow[]): BenchDocument {
  return {
    schema: "ludion.bench.v0",
    collected_at: "2026-06-12T10:00:00.000Z",
    device: {
      ua,
      webgpu,
      adapter: null,
      hw_concurrency: 8,
      device_memory_gb: null,
      screen: "390x844@3",
      operator_label: "",
    },
    sessions: [
      {
        engine: "webllm",
        model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        cache_state: "cold",
        started_at: "2026-06-12T10:00:00.000Z",
        ended_at: null,
        battery_start: null,
        battery_end: null,
      },
    ],
    runs,
    operator_notes: "",
  };
}

// --- computeAggregate (pure) ---------------------------------------------------

describe("computeAggregate", () => {
  it("buckets device classes and counts local-eligibility by representative rule", () => {
    const agg = computeAggregate([
      doc(UA.desktop, true, [okRun(20, 200)]), // R4 local
      doc(UA.android, true, [okRun(10, 15)]), // R5 local
      doc(UA.iphone, true, [failRun("init", "InitError")]), // R3 server
      doc(UA.fbiab, true, [failRun("generate", "TypeError")]), // R1 server (webview-iab)
      doc(UA.desktop, false, [failRun("init", "InitError")]), // R2 server
    ]);

    expect(agg.total_submissions).toBe(5);
    expect(agg.by_device_class.desktop.count).toBe(2);
    expect(agg.by_device_class.desktop.local_eligible).toBe(1); // only the webgpu:true one
    expect(agg.by_device_class["android-chromium"].count).toBe(1);
    expect(agg.by_device_class["android-chromium"].local_eligible).toBe(1);
    expect(agg.by_device_class["ios-webkit"].count).toBe(1);
    expect(agg.by_device_class["ios-webkit"].local_eligible).toBe(0);
    expect(agg.by_device_class["webview-iab"].count).toBe(1);
    expect(agg.by_device_class["webview-iab"].local_eligible).toBe(0);

    expect(agg.by_rule).toEqual({ R1: 1, R2: 1, R3: 1, R4: 1, R5: 1, R6: 0 });
  });

  it("emits medians at ≥3 contributing devices and excludes failed runs from them", () => {
    const agg = computeAggregate([
      doc(UA.desktop, true, [okRun(10, 100)]),
      doc(UA.desktop, true, [okRun(20, 200), failRun("generate", "TypeError")]), // fail excluded
      doc(UA.desktop, true, [okRun(30, 300)]),
    ]);
    const d = agg.by_device_class.desktop;
    expect(d.count).toBe(3);
    expect(d.completed).toBe(3);
    expect(d.median_decode_tps).toBe(20); // median of [10,20,30]
    expect(d.median_prefill_tps).toBe(200); // median of [100,200,300]
  });

  it("suppresses medians below K=3 contributing DEVICES, even if one has many runs (F-3)", () => {
    // The load-bearing case: one device with 3 successful runs must NOT surface its
    // own throughput as a "median" — k-anonymity counts devices, not runs.
    const agg = computeAggregate([
      doc(UA.desktop, true, [okRun(99, 999), okRun(98, 998), okRun(97, 997)]), // 1 device, 3 runs
      doc(UA.desktop, true, [okRun(88, 888)]), // 2nd device
    ]);
    const d = agg.by_device_class.desktop;
    expect(d.count).toBe(2);
    expect(d.completed).toBe(2);
    expect(d.median_decode_tps).toBeNull();
    expect(d.median_prefill_tps).toBeNull();
  });

  it("classifies failure modes per submission (completed / tab_death / init_fail / other)", () => {
    const agg = computeAggregate([
      doc(UA.desktop, true, [okRun(20, 200)]), // completed
      doc(UA.iphone, true, [failRun("generate", "OOMError")]), // tab_death (oom)
      doc(UA.iphone, true, [failRun("generate", "tab_kill")]), // tab_death (tab_kill)
      doc(UA.iphone, true, [failRun("init", "RuntimeError")]), // init_fail
      doc(UA.iphone, true, [failRun("download", "NetworkError")]), // other
    ]);
    expect(agg.failure_modes).toEqual({
      completed: 1,
      tab_death: 2,
      init_fail: 1,
      other: 1,
    });
  });

  it("never emits a UA string or raw device row (acceptance #2)", () => {
    const agg = computeAggregate([doc(UA.desktop, true, [okRun(20, 200)])]);
    const serialized = JSON.stringify(agg);
    expect(serialized).not.toContain("Mozilla/5.0");
    expect(serialized).not.toContain("Windows NT");
    // shape is class/rule/failure rollups only — no per-device array anywhere.
    expect(Object.keys(agg).sort()).toEqual(
      ["by_device_class", "by_rule", "failure_modes", "schema", "total_submissions", "updated_at"].sort(),
    );
  });

  it("emptyAggregate is a valid zeroed shell", () => {
    const a = emptyAggregate();
    expect(a.total_submissions).toBe(0);
    expect(a.updated_at).toBeNull();
    expect(a.by_rule).toEqual({ R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 });
    expect(a.by_device_class.other.count).toBe(0);
  });
});

// --- rebuildAggregate + storage ------------------------------------------------

describe("rebuildAggregate", () => {
  it("reads submissions from R2, writes the rollup to KV, skips non-submission keys", async () => {
    const env = makeEnv();
    env.SUBMISSIONS.objects.set("2026-06-12/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json", JSON.stringify(doc(UA.desktop, true, [okRun(20, 200)])));
    // Defensive belt (F-2): a stray non-submission object must be ignored.
    env.SUBMISSIONS.objects.set("aggregate.json", JSON.stringify({ junk: true }));
    env.SUBMISSIONS.objects.set("README", "not json");

    const agg = await rebuildAggregate(env);
    expect(agg.total_submissions).toBe(1);
    expect(agg.by_device_class.desktop.count).toBe(1);

    const stored = env.COLLECTOR_KV.store.get(AGGREGATE_KV_KEY);
    expect(stored).toBeDefined();
    expect((JSON.parse(stored!) as Aggregate).total_submissions).toBe(1);
  });

  it("skips objects that fail schema validation", async () => {
    const env = makeEnv();
    env.SUBMISSIONS.objects.set("2026-06-12/11111111-2222-3333-4444-555555555555.json", JSON.stringify({ schema: "wrong" }));
    const agg = await rebuildAggregate(env);
    expect(agg.total_submissions).toBe(0);
  });
});

// --- GET /v1/aggregate ---------------------------------------------------------

function getAggregate(env: CollectorEnv, headers: Record<string, string> = {}): Promise<Response> {
  return handleRequest(new Request("https://collector.test/v1/aggregate", { headers }), env);
}

describe("GET /v1/aggregate", () => {
  it("returns the empty shell (200) before any aggregate is built", async () => {
    const env = makeEnv();
    const res = await getAggregate(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Aggregate;
    expect(body.total_submissions).toBe(0);
    expect(body.updated_at).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("serves the precomputed rollup with O(1) KV read (no R2 list on the read path)", async () => {
    const env = makeEnv();
    env.SUBMISSIONS.objects.set("2026-06-12/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json", JSON.stringify(doc(UA.desktop, true, [okRun(20, 200)])));
    await rebuildAggregate(env);

    let listCalls = 0;
    const origList = env.SUBMISSIONS.list.bind(env.SUBMISSIONS);
    env.SUBMISSIONS.list = (...args) => {
      listCalls++;
      return origList(...args);
    };

    const res = await getAggregate(env);
    expect(res.status).toBe(200);
    expect((await res.json() as Aggregate).total_submissions).toBe(1);
    expect(listCalls).toBe(0); // read path must never list R2 (decisions OQ2)
  });

  it("echoes CORS for allowed origins and 405s non-GET", async () => {
    const env = makeEnv();
    const ok = await getAggregate(env, { Origin: "https://ludion-bench.pages.dev" });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://ludion-bench.pages.dev");
    const bad = await handleRequest(
      new Request("https://collector.test/v1/aggregate", { method: "POST" }),
      env,
    );
    expect(bad.status).toBe(405);
  });
});

// --- amortized rebuild on submit -----------------------------------------------

describe("submit triggers amortized rebuild via ctx.waitUntil", () => {
  it("rebuilds the aggregate after a new submission", async () => {
    const env = makeEnv();
    const ctx = drainCtx();
    const res = await handleRequest(
      new Request("https://collector.test/v1/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify(doc(UA.desktop, true, [okRun(20, 200)])),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await ctx.settled;
    const stored = env.COLLECTOR_KV.store.get(AGGREGATE_KV_KEY);
    expect(stored).toBeDefined();
    expect((JSON.parse(stored!) as Aggregate).total_submissions).toBe(1);
  });
});
