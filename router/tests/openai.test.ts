import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatCompletionChunk, RouterProbe } from "@ludion/shared";
import OpenAI from "../src/openai";
import {
  DROPIN_CONFIG_VERSION,
  LudionConfigError,
  setDropinConfig,
  validateDropinConfig,
} from "../src/openai";
import { _resetDropinCache, resolveRouting } from "../src/dropin";
import { DEFAULT_LOCAL_MODEL } from "../src/defaults";
import type { LocalExecutor } from "../src/local";
import type { ServerExecutor } from "../src/server";
import type { KV } from "../src/strikes";

// --- fixtures (mirrors facade.test.ts) --------------------------------------

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
const DESKTOP = probeOf();
const IPHONE = probeOf({ os_class: "ios-webkit", webgpu: false, adapter: null });

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function completionOf(text: string, model: string): ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

function chunkOf(content: string, model: string): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

const mockLocal: LocalExecutor = {
  async ensureLoaded() {},
  // eslint-disable-next-line @typescript-eslint/require-await
  async stream() {
    return (async function* () {
      yield chunkOf("loc-a", "local-model");
      yield chunkOf("loc-b", "local-model");
    })();
  },
  async complete() {
    return completionOf("local says hi", "local-model");
  },
  async interrupt() {},
};

const mockServer: ServerExecutor = {
  async *stream() {
    yield chunkOf("srv-a", "server-model");
    yield chunkOf("srv-b", "server-model");
  },
  async complete() {
    return completionOf("server says hi", "server-model");
  },
};

const MESSAGES = [{ role: "user" as const, content: "hello there" }];

beforeEach(() => {
  _resetDropinCache();
  setDropinConfig(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- the headline proof: change ONE import line ------------------------------

describe("OpenAI drop-in: import-line-only compatibility", () => {
  it("on-device where eligible: desktop+WebGPU runs local, response is OpenAI-shaped with _ludion", async () => {
    // Existing OpenAI code, verbatim except the import:
    const client = new OpenAI({
      apiKey: "sk-test",
      __ludionTest: { probe: DESKTOP, kv: memKV(), localExecutor: mockLocal },
    });
    const res = await client.chat.completions.create({ model: "gpt-4o", messages: MESSAGES });

    expect(res.choices[0]?.message.content).toBe("local says hi");
    expect(res._ludion.target).toBe("local");
    expect(res._ludion.rule_id).toBe("R4");
    // on-device uses the router's local model; the caller's "gpt-4o" is NOT
    // forced onto the device — it is the fallback target only.
    expect(res._ludion.model).toBe(DEFAULT_LOCAL_MODEL);
    // _ludion must not break code that iterates the response.
    expect(Object.keys(res)).not.toContain("_ludion");
  });

  it("degrades to the caller's model otherwise: no-WebGPU routes to the named fallback target", async () => {
    const client = new OpenAI({
      apiKey: "sk-test",
      __ludionTest: { probe: IPHONE, kv: memKV(), serverExecutor: mockServer },
    });
    const res = await client.chat.completions.create({ model: "gpt-4o", messages: MESSAGES });

    expect(res.choices[0]?.message.content).toBe("server says hi");
    expect(res._ludion.target).toBe("server");
    // caller's model string IS the fallback target (not overridden, not "auto").
    expect(res._ludion.model).toBe("gpt-4o");
  });

  it("streaming surface: returns an async-iterable carrying _ludion", async () => {
    const client = new OpenAI({
      apiKey: "sk-test",
      __ludionTest: { probe: DESKTOP, kv: memKV(), localExecutor: mockLocal },
    });
    const stream = await client.chat.completions.create({
      model: "gpt-4o",
      messages: MESSAGES,
      stream: true,
    });
    let text = "";
    for await (const c of stream) text += c.choices[0]?.delta?.content ?? "";
    expect(text).toBe("loc-aloc-b");
    expect(stream._ludion.target).toBe("local");
    expect(Object.keys(stream)).not.toContain("_ludion");
  });

  it("true zero-extra-args: real fetch degrade hits baseURL/chat/completions with the key + caller model", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, _init) =>
        new Response(JSON.stringify(completionOf("from your endpoint", "gpt-4o")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    // No __ludionTest: node has no navigator → fallback probe (no WebGPU) → R2
    // server. The engine is never imported. Only the import line differs from
    // real OpenAI usage.
    const client = new OpenAI({ apiKey: "sk-secret", baseURL: "https://relay.example.test/v1" });
    const res = await client.chat.completions.create({ model: "gpt-4o", messages: MESSAGES });

    expect(res.choices[0]?.message.content).toBe("from your endpoint");
    expect(res._ludion.target).toBe("server");
    expect(res._ludion.model).toBe("gpt-4o");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://relay.example.test/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o"); // caller model → fallback target
  });
});

// --- the external config injection seam (Spec B will back this with a UI) ----

describe("config injection seam", () => {
  it("resolveRouting: constructor baseURL/apiKey override injected config", () => {
    setDropinConfig({
      fallback: { baseURL: "https://injected.example/v1", model: "default-model", apiKey: "sk-injected" },
    });
    // constructor wins for the fields it carries; request model wins for model.
    const r = resolveRouting({ apiKey: "sk-ctor", baseURL: "https://ctor.example/v1" }, "gpt-4o");
    expect(r.fallback?.url).toBe("https://ctor.example/v1/chat/completions");
    expect(r.fallback?.model).toBe("gpt-4o");
    expect(r.fallback && "apiKey" in r.fallback ? r.fallback.apiKey : null).toBe("sk-ctor");
  });

  it("resolveRouting: injected config fills the gaps (baseURL + default model)", () => {
    setDropinConfig({ fallback: { baseURL: "https://injected.example/v1", model: "default-model" } });
    const r = resolveRouting({ apiKey: "sk-ctor" }, undefined);
    expect(r.fallback?.url).toBe("https://injected.example/v1/chat/completions");
    expect(r.fallback?.model).toBe("default-model");
  });

  it("resolveRouting: defaults baseURL to api.openai.com when nothing is supplied", () => {
    const r = resolveRouting({ apiKey: "sk-ctor" }, "gpt-4o");
    expect(r.fallback?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("validateDropinConfig: rejects an unsupported config_version", () => {
    expect(() => validateDropinConfig({ config_version: 999 })).toThrow(LudionConfigError);
    expect(DROPIN_CONFIG_VERSION).toBe(1);
  });

  it("validateDropinConfig: rejects a malformed fallback", () => {
    expect(() => validateDropinConfig({ fallback: { baseURL: 42 } })).toThrow(LudionConfigError);
  });

  it("validateDropinConfig: accepts a well-formed config", () => {
    expect(() =>
      validateDropinConfig({ config_version: 1, fallback: { baseURL: "https://x/v1", model: "m" } }),
    ).not.toThrow();
  });
});
