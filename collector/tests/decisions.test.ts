import { describe, expect, it } from "vitest";
import {
  DECISIONS_DAILY_LIMIT,
  DECISIONS_MAX_BODY_BYTES,
  handleRequest,
  type CollectorEnv,
  type KVLike,
  type R2Like,
} from "../src/handler";

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
    ALLOWED_ORIGINS: "https://ludion.ai",
    IP_HASH_SALT: "test-salt",
    ADMIN_TOKEN: "test-token",
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "decision.v1",
    decision_id: `d_${Math.random().toString(36).slice(2)}`,
    route: "local",
    model: "qwen2.5-0.5b",
    webgpu_supported: true,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "decision.v1",
    projectId: "proj-abc",
    install_id: "inst-1",
    events: [event()],
    ...overrides,
  };
}

function post(env: CollectorEnv, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return handleRequest(
    new Request("https://collector.test/v1/decisions", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
      body,
    }),
    env,
  );
}

describe("POST /v1/decisions", () => {
  it("rejects a non-POST method", async () => {
    const res = await handleRequest(
      new Request("https://collector.test/v1/decisions", { method: "GET" }),
      makeEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON", async () => {
    const res = await post(makeEnv(), "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_json");
  });

  it("rejects a batch carrying a content field (allow-list gate)", async () => {
    const res = await post(makeEnv(), JSON.stringify(batch({ events: [event({ prompt: "leak" })] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("schema_invalid");
  });

  it("rejects an unsafe projectId (no path traversal in the R2 key)", async () => {
    const res = await post(makeEnv(), JSON.stringify(batch({ projectId: "../etc/passwd" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_project");
  });

  it("stores a valid batch under a per-project key and counts events", async () => {
    const env = makeEnv();
    const res = await post(env, JSON.stringify(batch({ events: [event(), event()] })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.stored_events).toBe(2);
    expect(json.total_events).toBe(2);

    const keys = [...env.SUBMISSIONS.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("decisions/proj-abc/")).toBe(true);

    // Stored object is the batch + received_at and nothing content-shaped.
    const stored = JSON.parse(env.SUBMISSIONS.objects.get(keys[0]!)!);
    expect(stored.projectId).toBe("proj-abc");
    expect(typeof stored.received_at).toBe("string");
    expect(env.COLLECTOR_KV.store.get("decisions:project:proj-abc")).toBe("2");
    expect(env.COLLECTOR_KV.store.get("decisions:total")).toBe("2");
  });

  it("does not collide with the bench submission storage prefix", async () => {
    const env = makeEnv();
    await post(env, JSON.stringify(batch()));
    const keys = [...env.SUBMISSIONS.objects.keys()];
    // bench keys are "<date>/uuid.json"; decisions are "decisions/<project>/<date>/uuid.json"
    expect(keys.every((k) => k.startsWith("decisions/"))).toBe(true);
  });

  it("rate-limits on its own key prefix without affecting bench", async () => {
    const env = makeEnv();
    env.COLLECTOR_KV.store.set(
      `rld:${new Date().toISOString().slice(0, 10)}:${"x".repeat(64)}`,
      String(DECISIONS_DAILY_LIMIT),
    );
    // A fresh IP still under limit succeeds (separate hash key).
    const res = await post(env, JSON.stringify(batch()));
    expect(res.status).toBe(200);
  });

  it("rejects an oversized body", async () => {
    const res = await post(makeEnv(), "{}", {
      "content-length": String(DECISIONS_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });
});
