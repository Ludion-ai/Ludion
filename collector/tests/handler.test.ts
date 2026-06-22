import { describe, expect, it } from "vitest";
import {
  DAILY_LIMIT,
  MAX_BODY_BYTES,
  handleRequest,
  type CollectorEnv,
  type KVLike,
  type R2Like,
} from "../src/handler";

// --- hand-rolled in-memory bindings (decisions Q2) ---------------------------

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

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "ludion.bench.v0",
    collected_at: "2026-06-12T10:00:00.000Z",
    device: {
      ua: "TestUA/1.0",
      webgpu: false,
      adapter: null,
      hw_concurrency: 8,
      device_memory_gb: null,
      screen: "390x844@3",
      operator_label: "test-device",
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
    runs: [],
    operator_notes: "",
    ...overrides,
  };
}

function submit(
  env: CollectorEnv,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleRequest(
    new Request("https://collector.test/v1/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
      body,
    }),
    env,
  );
}

// --- submit ------------------------------------------------------------------

describe("POST /v1/submit", () => {
  it("stores a valid document and returns the counter", async () => {
    const env = makeEnv();
    const res = await submit(env, JSON.stringify(validDoc()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deduped: false, total_submissions: 1 });
    expect(env.SUBMISSIONS.objects.size).toBe(1);
    const key = [...env.SUBMISSIONS.objects.keys()][0]!;
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.json$/);
  });

  it("accepts the legacy entelic.bench.v0 alias", async () => {
    const env = makeEnv();
    const res = await submit(env, JSON.stringify(validDoc({ schema: "entelic.bench.v0" })));
    expect(res.status).toBe(200);
  });

  it("stored object = submitted JSON + received_at only; no IP anywhere", async () => {
    const env = makeEnv();
    const doc = validDoc();
    await submit(env, JSON.stringify(doc));
    const stored = JSON.parse([...env.SUBMISSIONS.objects.values()][0]!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored).sort()).toEqual([...Object.keys(doc), "received_at"].sort());
    expect(typeof stored.received_at).toBe("string");
    // Privacy (acceptance 3): the submitter's IP must not appear in the object.
    expect(JSON.stringify(stored)).not.toContain("203.0.113.7");
  });

  it("rejects oversize bodies declared via Content-Length", async () => {
    const env = makeEnv();
    const res = await submit(env, "{}", { "Content-Length": String(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_large");
  });

  it("rejects oversize actual bodies (chunked bypass)", async () => {
    const env = makeEnv();
    const doc = validDoc({ operator_notes: "x".repeat(MAX_BODY_BYTES) });
    const res = await submit(env, JSON.stringify(doc));
    expect(res.status).toBe(413);
    expect(env.SUBMISSIONS.objects.size).toBe(0);
  });

  it("rejects invalid JSON / invalid schema / empty sessions with typed codes", async () => {
    const env = makeEnv();
    const cases: [string, string][] = [
      ["{nope", "invalid_json"],
      [JSON.stringify({ schema: "wrong.schema" }), "schema_invalid"],
      [JSON.stringify(validDoc({ sessions: [] })), "no_sessions"],
    ];
    for (const [body, code] of cases) {
      const res = await submit(env, body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe(code);
    }
    expect(env.SUBMISSIONS.objects.size).toBe(0);
  });

  it("dedupes identical resubmission without storing twice", async () => {
    const env = makeEnv();
    const body = JSON.stringify(validDoc());
    await submit(env, body);
    const res = await submit(env, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deduped: true, total_submissions: 1 });
    expect(env.SUBMISSIONS.objects.size).toBe(1);
  });

  it(`rejects the ${DAILY_LIMIT + 1}th submission from one IP with 429`, async () => {
    const env = makeEnv();
    for (let i = 0; i < DAILY_LIMIT; i++) {
      const res = await submit(env, JSON.stringify(validDoc({ collected_at: `t-${i}` })));
      expect(res.status).toBe(200);
    }
    const res = await submit(env, JSON.stringify(validDoc({ collected_at: "t-final" })));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("86400");
    expect(env.SUBMISSIONS.objects.size).toBe(DAILY_LIMIT);
    // ...but a different IP still passes (per-IP, not global).
    const other = await submit(env, JSON.stringify(validDoc({ collected_at: "t-other" })), {
      "CF-Connecting-IP": "198.51.100.1",
    });
    expect(other.status).toBe(200);
  });

  it("raw IP never persisted: KV keys contain only the salted hash", async () => {
    const env = makeEnv();
    await submit(env, JSON.stringify(validDoc()));
    for (const key of env.COLLECTOR_KV.store.keys()) {
      expect(key).not.toContain("203.0.113.7");
    }
  });

  it("rejects browser submissions from foreign origins", async () => {
    const env = makeEnv();
    const res = await submit(env, JSON.stringify(validDoc()), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes CORS headers for allowed origins", async () => {
    const env = makeEnv();
    const res = await submit(env, JSON.stringify(validDoc()), {
      Origin: "https://ludion-bench.pages.dev",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ludion-bench.pages.dev");
  });

  it("answers OPTIONS preflight for allowed origins", async () => {
    const env = makeEnv();
    const res = await handleRequest(
      new Request("https://collector.test/v1/submit", {
        method: "OPTIONS",
        headers: { Origin: "https://ludion-bench.pages.dev" },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ludion-bench.pages.dev");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("405s non-POST", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request("https://collector.test/v1/submit"), env);
    expect(res.status).toBe(405);
  });
});

// --- stats ---------------------------------------------------------------------

describe("GET /v1/stats", () => {
  it("returns the public counter with 60s cache", async () => {
    const env = makeEnv();
    await submit(env, JSON.stringify(validDoc()));
    const res = await handleRequest(new Request("https://collector.test/v1/stats"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total_submissions: 1, decisions_total: 0 });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("omits a per-project decision count unless a valid projectId is given", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request("https://collector.test/v1/stats"), env);
    expect(await res.json()).not.toHaveProperty("decisions_project");
    const bad = await handleRequest(
      new Request("https://collector.test/v1/stats?projectId=../etc"),
      env,
    );
    expect(await bad.json()).not.toHaveProperty("decisions_project");
  });
});

// --- admin ----------------------------------------------------------------------

describe("/v1/admin/*", () => {
  it("401s without the bearer token", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request("https://collector.test/v1/admin/list"), env);
    expect(res.status).toBe(401);
  });

  it("lists and fetches stored objects with the token", async () => {
    const env = makeEnv();
    await submit(env, JSON.stringify(validDoc()));
    const auth = { Authorization: "Bearer test-token" };
    const list = await handleRequest(
      new Request("https://collector.test/v1/admin/list", { headers: auth }),
      env,
    );
    expect(list.status).toBe(200);
    const { keys } = (await list.json()) as { keys: string[] };
    expect(keys).toHaveLength(1);
    const object = await handleRequest(
      new Request(`https://collector.test/v1/admin/object?key=${encodeURIComponent(keys[0]!)}`, {
        headers: auth,
      }),
      env,
    );
    expect(object.status).toBe(200);
    const doc = (await object.json()) as { received_at?: string };
    expect(doc.received_at).toBeDefined();
  });

  it("404s unknown routes", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request("https://collector.test/nope"), env);
    expect(res.status).toBe(404);
  });
});
