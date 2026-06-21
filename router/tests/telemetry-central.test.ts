import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDecisionBatch } from "@ludion/shared";
import { _resetTelemetry, emitDecision } from "../src/telemetry";
import { _resetCentralTelemetry, enableCentralTelemetry } from "../src/telemetry-central";
import { setDropinConfig } from "../src/config";
import type { DecisionLog } from "../src/types";

function log(over: Partial<DecisionLog> = {}): DecisionLog {
  return {
    schema_version: "decision.v1",
    decision_id: `d_${Math.random().toString(36).slice(2)}`,
    policy_version: "v0",
    rule_id: "R4",
    target: "local",
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    privacy: false,
    stream: true,
    est_prompt_tokens: 10,
    max_tokens: 256,
    local_context_window: 4096,
    cache_state: "cold",
    load_total_ms: null,
    strike_state: {},
    probe: {
      ua: "test-ua",
      webgpu: true,
      adapter: null,
      hw_concurrency: 8,
      device_memory_gb: 8,
      env: "browser",
      os_class: "ios-webkit",
    },
    decided_at: "2026-06-15T10:00:00.000Z",
    completed: true,
    degraded: null,
    degraded_failed: false,
    cancelled: false,
    ttft_ms: 100,
    tps: 20,
    tokens_in: 80,
    tokens_out: 50,
    tokens_source: "exact",
    error: null,
    ...over,
  };
}

class MemStorage {
  store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
}

/** Let the sink microtask drain run, then the async flush settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  _resetCentralTelemetry();
  _resetTelemetry();
  setDropinConfig(null);
});

const ON_CONFIG = {
  config_version: 1,
  projectId: "proj-abc",
  telemetry: { central: true, endpoint: "https://collector.test" },
};

describe("central telemetry (opt-in)", () => {
  it("sends nothing when central is off (default)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    enableCentralTelemetry({ fetchImpl, storage: new MemStorage(), flushThreshold: 1 });
    emitDecision(log());
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing when central:true but projectId is missing", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    setDropinConfig({ config_version: 1, telemetry: { central: true, endpoint: "https://collector.test" } });
    enableCentralTelemetry({ fetchImpl, storage: new MemStorage(), flushThreshold: 1 });
    emitDecision(log());
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs a valid content-free batch to <endpoint>/v1/decisions when opted in", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true };
    });
    setDropinConfig(ON_CONFIG);
    enableCentralTelemetry({ fetchImpl, storage: new MemStorage(), flushThreshold: 1 });
    emitDecision(log());
    await settle();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe("https://collector.test/v1/decisions");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.projectId).toBe("proj-abc");
    expect(typeof body.install_id).toBe("string");
    expect(body.install_id.length).toBeGreaterThan(0);
    expect(validateDecisionBatch(body)).toEqual({ ok: true, errors: [] });
  });

  it("reuses a persisted install id across batches", async () => {
    const ids: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).install_id);
      return { ok: true };
    });
    const storage = new MemStorage();
    setDropinConfig(ON_CONFIG);
    enableCentralTelemetry({ fetchImpl, storage, flushThreshold: 1 });
    emitDecision(log());
    await settle();
    emitDecision(log());
    await settle();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(storage.getItem("ludion.install.v1")).toBe(ids[0]);
  });

  it("never throws when the transport fails (fail-silent)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    setDropinConfig(ON_CONFIG);
    enableCentralTelemetry({ fetchImpl, storage: new MemStorage(), flushThreshold: 1 });
    expect(() => emitDecision(log())).not.toThrow();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("batches a partial burst into a single timer-driven request", async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return { ok: true };
    });
    setDropinConfig(ON_CONFIG);
    // High threshold (no size-triggered flush) + short interval (timer flush).
    enableCentralTelemetry({ fetchImpl, storage: new MemStorage(), flushThreshold: 10, flushIntervalMs: 5 });
    for (let i = 0; i < 3; i++) emitDecision(log());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((captured as { events: unknown[] }).events).toHaveLength(3);
  });
});
