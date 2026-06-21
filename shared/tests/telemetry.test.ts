import { describe, expect, it } from "vitest";
import {
  DECISION_SCHEMA_VERSION,
  MAX_BATCH_EVENTS,
  validateDecisionBatch,
  validateDecisionEvent,
  type DecisionEvent,
} from "../src/telemetry";

function event(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    schema_version: DECISION_SCHEMA_VERSION,
    decision_id: "d_1",
    route: "local",
    model: "qwen2.5-0.5b",
    webgpu_supported: true,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("validateDecisionEvent", () => {
  it("accepts a minimal well-formed event", () => {
    expect(validateDecisionEvent(event())).toEqual({ ok: true, errors: [] });
  });

  it("accepts input_tokens/output_tokens despite the substring 'token'", () => {
    const r = validateDecisionEvent(event({ input_tokens: 12, output_tokens: 34 }));
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown key (content-free gate)", () => {
    const r = validateDecisionEvent({ ...event(), prompt: "secret" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("rejects a nested object where content could hide", () => {
    const r = validateDecisionEvent({ ...event(), model: { text: "x" } as unknown as string });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong schema_version", () => {
    const r = validateDecisionEvent({ ...event(), schema_version: "decision.v2" as never });
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range route and cache_state", () => {
    expect(validateDecisionEvent({ ...event(), route: "moon" as never }).ok).toBe(false);
    expect(validateDecisionEvent({ ...event(), cache_state: "lukewarm" as never }).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateDecisionEvent(null).ok).toBe(false);
    expect(validateDecisionEvent([event()]).ok).toBe(false);
  });
});

describe("validateDecisionBatch", () => {
  function batch(overrides: Record<string, unknown> = {}): unknown {
    return {
      schema_version: DECISION_SCHEMA_VERSION,
      projectId: "proj_1",
      install_id: "inst_1",
      events: [event()],
      ...overrides,
    };
  }

  it("accepts a well-formed batch", () => {
    expect(validateDecisionBatch(batch())).toEqual({ ok: true, errors: [] });
  });

  it("rejects an empty events array", () => {
    expect(validateDecisionBatch(batch({ events: [] })).ok).toBe(false);
  });

  it("rejects a batch over the event cap", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => event());
    expect(validateDecisionBatch(batch({ events })).ok).toBe(false);
  });

  it("rejects a missing projectId/install_id", () => {
    expect(validateDecisionBatch(batch({ projectId: "" })).ok).toBe(false);
    expect(validateDecisionBatch(batch({ install_id: undefined })).ok).toBe(false);
  });

  it("propagates a bad event's errors", () => {
    const r = validateDecisionBatch(batch({ events: [{ ...event(), leaked: "x" }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("events[0]"))).toBe(true);
  });

  it("rejects an unknown top-level batch key", () => {
    expect(validateDecisionBatch(batch({ extra: 1 })).ok).toBe(false);
  });
});
