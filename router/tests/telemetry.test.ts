import { afterEach, describe, expect, it } from "vitest";
import {
  _resetTelemetry,
  emitDecision,
  newDecisionId,
  registerDecisionConsumer,
  toDecisionEvent,
} from "../src/telemetry";
import type { DecisionLog } from "../src/types";

function log(over: Partial<DecisionLog> = {}): DecisionLog {
  return {
    schema_version: "decision.v1",
    decision_id: "test-decision",
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
    load_total_ms: 1234,
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

afterEach(() => {
  _resetTelemetry();
});

describe("toDecisionEvent route mapping", () => {
  it("maps a clean local decision to route=local", () => {
    const e = toDecisionEvent(log({ target: "local" }));
    expect(e.route).toBe("local");
    expect(e.fallback_reason).toBeUndefined();
  });

  it("maps a server decision to route=cloud", () => {
    expect(toDecisionEvent(log({ target: "server" })).route).toBe("cloud");
  });

  it("maps a degraded decision to route=fallback with local_unavailable", () => {
    const e = toDecisionEvent(log({ target: "server", degraded: "local→server" }));
    expect(e.route).toBe("fallback");
    expect(e.fallback_reason).toBe("local_unavailable");
  });

  it("maps an unroutable privacy decision to route=error", () => {
    const e = toDecisionEvent(log({ target: "unroutable" }));
    expect(e.route).toBe("error");
    expect(e.fallback_reason).toBe("privacy_unroutable");
  });

  it("maps a mid-stream local failure to route=error", () => {
    const e = toDecisionEvent(log({ error: "boom", degraded_failed: true }));
    expect(e.route).toBe("error");
    expect(e.fallback_reason).toBe("local_failed_mid_stream");
  });

  it("carries device_class, webgpu, and load metrics through", () => {
    const e = toDecisionEvent(log());
    expect(e.device_class).toBe("ios-webkit");
    expect(e.webgpu_supported).toBe(true);
    expect(e.latency_ms).toBe(100);
    expect(e.load_total_ms).toBe(1234);
    expect(e.cache_state).toBe("cold");
    expect(e.input_tokens).toBe(80);
    expect(e.output_tokens).toBe(50);
  });

  it("omits optional numeric fields when null", () => {
    const e = toDecisionEvent(log({ ttft_ms: null, load_total_ms: null, tokens_in: null, tokens_out: null }));
    expect(e.latency_ms).toBeUndefined();
    expect(e.load_total_ms).toBeUndefined();
    expect(e.input_tokens).toBeUndefined();
    expect(e.output_tokens).toBeUndefined();
  });

  it("falls back to now() for an unparseable decided_at", () => {
    const e = toDecisionEvent(log({ decided_at: "not-a-date" }));
    expect(Number.isFinite(e.timestamp)).toBe(true);
  });
});

describe("newDecisionId", () => {
  it("returns a non-empty, content-free, unique id", () => {
    const a = newDecisionId();
    const b = newDecisionId();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});

describe("decision sink", () => {
  it("is a no-op when no consumer is registered", async () => {
    // Should not throw and nothing to observe.
    emitDecision(log());
    await Promise.resolve();
    expect(true).toBe(true);
  });

  it("delivers a buffered decision to a consumer on the microtask drain", async () => {
    const seen: DecisionLog[] = [];
    registerDecisionConsumer((l) => seen.push(l));
    emitDecision(log({ decision_id: "x1" }));
    expect(seen).toHaveLength(0); // async — not yet drained
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.map((l) => l.decision_id)).toEqual(["x1"]);
  });

  it("isolates a throwing consumer from others", async () => {
    const seen: string[] = [];
    registerDecisionConsumer(() => {
      throw new Error("bad consumer");
    });
    registerDecisionConsumer((l) => seen.push(l.decision_id));
    emitDecision(log({ decision_id: "x2" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["x2"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const seen: string[] = [];
    const off = registerDecisionConsumer((l) => seen.push(l.decision_id));
    off();
    emitDecision(log());
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  it("batches multiple emits into one drain", async () => {
    const seen: string[] = [];
    registerDecisionConsumer((l) => seen.push(l.decision_id));
    emitDecision(log({ decision_id: "a" }));
    emitDecision(log({ decision_id: "b" }));
    emitDecision(log({ decision_id: "c" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["a", "b", "c"]);
  });
});
