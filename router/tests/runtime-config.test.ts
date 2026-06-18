import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatMessage, RouterProbe } from "@ludion/shared";
import {
  Ludion,
  LudionConfigError,
  LudionNoFallbackConfigured,
  createStorageConfigSource,
  setConfigSource,
  setDropinConfig,
  writeDropinConfig,
} from "../src/index";
import type { ConfigStorage } from "../src/index";
import type { KV } from "../src/strikes";

// --- fixtures (mirror facade.test.ts / openai.test.ts) ----------------------

const probeOf = (over: Partial<RouterProbe> = {}): RouterProbe => ({
  ua: "test",
  webgpu: true,
  adapter: { vendor: "t", architecture: "t", f16: true, maxBufferSize: 1 << 30 },
  hw_concurrency: 8,
  device_memory_gb: null,
  env: "browser",
  os_class: "desktop",
  ...over,
});
// No WebGPU → R2 routes to the server, exercising the fallback read-point.
const SERVER = probeOf({ webgpu: false, adapter: null });

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function memStorage(): ConfigStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function completionOf(text: string, model = "m"): ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

function stubFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(completionOf("ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

type FetchCall = Parameters<typeof fetch>;
function urlOf(call: FetchCall): string {
  return call[0] as string;
}
function bodyModelOf(call: FetchCall): string {
  return JSON.parse((call[1] as RequestInit).body as string).model as string;
}
function authOf(call: FetchCall): string | undefined {
  return ((call[1] as RequestInit).headers as Record<string, string>).authorization;
}

beforeEach(() => {
  // Reset to the in-memory default source, cleared, between tests.
  setDropinConfig(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  setDropinConfig(null);
});

// --- the no-reload loop at the facade read-point -----------------------------

describe("runtime config: facade reads the live config per request", () => {
  it("config set AFTER create() is honored by the next request, no recreate (no reload)", async () => {
    const fetchSpy = stubFetch();
    const ludion = await Ludion.create({ _test: { probe: SERVER, kv: memKV() } });

    setDropinConfig({ fallback: { baseURL: "https://a.test/v1", model: "model-a", apiKey: "key-a" } });
    await ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 });

    // Change config on the SAME instance — no second Ludion.create(), no reload.
    setDropinConfig({ fallback: { baseURL: "https://b.test/v2", model: "model-b" } });
    await ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const c1 = fetchSpy.mock.calls[0]!;
    const c2 = fetchSpy.mock.calls[1]!;
    expect(urlOf(c1)).toBe("https://a.test/v1/chat/completions");
    expect(bodyModelOf(c1)).toBe("model-a");
    expect(authOf(c1)).toBe("Bearer key-a");
    expect(urlOf(c2)).toBe("https://b.test/v2/chat/completions");
    expect(bodyModelOf(c2)).toBe("model-b");
    expect(authOf(c2)).toBeUndefined();
  });

  it("create()-time fallback wins per field; live config fills only the gaps (apiKey)", async () => {
    const fetchSpy = stubFetch();
    const ludion = await Ludion.create({
      fallback: { url: "https://base.test/chat/completions", model: "base-model" },
      _test: { probe: SERVER, kv: memKV() },
    });
    setDropinConfig({ fallback: { baseURL: "https://live.test/v1", model: "live-model", apiKey: "live-key" } });
    await ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 });

    const c = fetchSpy.mock.calls[0]!;
    expect(urlOf(c)).toBe("https://base.test/chat/completions"); // base url wins
    expect(bodyModelOf(c)).toBe("base-model"); // base model wins
    expect(authOf(c)).toBe("Bearer live-key"); // base had no key → live fills
  });

  it("no create()-time fallback and no live config preserves Phase 0 (LudionNoFallbackConfigured)", async () => {
    const ludion = await Ludion.create({ _test: { probe: SERVER, kv: memKV() } });
    await expect(
      ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 }),
    ).rejects.toBeInstanceOf(LudionNoFallbackConfigured);
  });
});

// --- the storage-backed source -----------------------------------------------

describe("runtime config: storage-backed source", () => {
  it("writes, reads, and clears a config round-trip", () => {
    const mem = memStorage();
    const src = createStorageConfigSource({ storage: mem, key: "k" });
    expect(src.get()).toBeNull();
    writeDropinConfig({ fallback: { baseURL: "https://x/v1", model: "m" } }, { storage: mem, key: "k" });
    expect(src.get()?.fallback?.model).toBe("m");
    writeDropinConfig(null, { storage: mem, key: "k" });
    expect(src.get()).toBeNull();
  });

  it("corrupt stored config falls back to defaults and warns once", () => {
    const mem = memStorage();
    mem.setItem("k", "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = createStorageConfigSource({ storage: mem, key: "k" });
    expect(src.get()).toBeNull();
    expect(src.get()).toBeNull(); // second corrupt read: still warned once
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid config at write time, before persisting", () => {
    const mem = memStorage();
    expect(() =>
      writeDropinConfig({ fallback: { model: 5 } } as never, { storage: mem, key: "k" }),
    ).toThrow(LudionConfigError);
    expect(mem.getItem("k")).toBeNull();
  });
});

// --- the full UI loop: storage source + write → next request honors it -------

describe("runtime config: the no-reload loop end to end", () => {
  it("setConfigSource(storage) + writeDropinConfig: next request uses it, no reload", async () => {
    const fetchSpy = stubFetch();
    const mem = memStorage();
    setConfigSource(createStorageConfigSource({ storage: mem }));
    const ludion = await Ludion.create({ _test: { probe: SERVER, kv: memKV() } });

    // Nothing stored yet → Phase 0 typed error (no fetch).
    await expect(
      ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 }),
    ).rejects.toBeInstanceOf(LudionNoFallbackConfigured);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The "UI save": persist via the storage source. No location.reload().
    writeDropinConfig({ fallback: { baseURL: "https://s/v1", model: "sm" } }, { storage: mem });

    // Next request on the SAME Ludion instance honors the new config.
    const res = await ludion.chat.completions.create({ messages: MESSAGES, max_tokens: 16 });
    expect(res._ludion.target).toBe("server");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchSpy.mock.calls[0]!)).toBe("https://s/v1/chat/completions");
    expect(bodyModelOf(fetchSpy.mock.calls[0]!)).toBe("sm");
  });
});
