import { describe, expect, it } from "vitest";
import type { ChatCompletion, ChatCompletionChunk, RouterProbe } from "@ludion/shared";
import { Ludion, LudionMidStreamError, LudionNoFallbackConfigured, LudionPrivacyUnroutable } from "../src/index";
import type { DecisionLog, LudionOptions } from "../src/index";
import { DEFAULT_LOCAL_MODEL } from "../src/defaults";
import type { LocalExecutor } from "../src/local";
import type { ServerExecutor } from "../src/server";
import { DEFAULT_STRIKE_TTL_MS, StrikeStore } from "../src/strikes";
import type { KV } from "../src/strikes";

// --- fixtures ---------------------------------------------------------------

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

function chunk(content: string, model = "mock"): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

function usageChunk(model = "mock"): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

function completionOf(text: string, model = "mock"): ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

interface ServerSpy {
  streamCalls: number;
  completeCalls: number;
  lastSignal: AbortSignal | null;
}

function mockServer(spy: ServerSpy): ServerExecutor {
  return {
    async *stream(_req, signal) {
      spy.streamCalls++;
      spy.lastSignal = signal;
      yield chunk("srv-a", "server-model");
      yield chunk("srv-b", "server-model");
      yield usageChunk("server-model");
    },
    async complete(_req, signal) {
      spy.completeCalls++;
      spy.lastSignal = signal;
      return completionOf("server says hi", "server-model");
    },
  };
}

interface LocalSpy {
  loadCalls: number;
  streamCalls: number;
  completeCalls: number;
  interruptCalls: number;
}

type LocalMode =
  | { kind: "ok" }
  | { kind: "fail-load"; error: Error }
  | { kind: "fail-pre-token"; error: Error }
  | { kind: "fail-mid-stream"; error: Error }
  | { kind: "hang-after-first" };

function mockLocal(spy: LocalSpy, mode: LocalMode = { kind: "ok" }): LocalExecutor {
  let interrupted = false;
  return {
    async ensureLoaded() {
      spy.loadCalls++;
      if (mode.kind === "fail-load") throw mode.error;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async stream() {
      spy.streamCalls++;
      return (async function* () {
        if (mode.kind === "fail-pre-token") throw mode.error;
        yield chunk("loc-a", "local-model");
        if (mode.kind === "fail-mid-stream") throw mode.error;
        if (mode.kind === "hang-after-first") {
          while (!interrupted) await new Promise((r) => setTimeout(r, 1));
          return;
        }
        yield chunk("loc-b", "local-model");
        yield usageChunk("local-model");
      })();
    },
    async complete() {
      spy.completeCalls++;
      if (mode.kind !== "ok") throw ("error" in mode ? mode.error : new Error("mock"));
      return completionOf("local says hi", "local-model");
    },
    async interrupt() {
      spy.interruptCalls++;
      interrupted = true;
    },
  };
}

interface Harness {
  ludion: Ludion;
  kv: KV;
  serverSpy: ServerSpy;
  localSpy: LocalSpy;
  decisions: DecisionLog[];
  tick: (ms: number) => void;
}

async function harness(opts: {
  probe?: RouterProbe;
  localMode?: LocalMode;
  kv?: KV;
  hints?: LudionOptions["hints"];
  startClock?: number;
}): Promise<Harness> {
  // starts at real time so verification reads via `new StrikeStore(kv)`
  // (real Date.now) don't see fake-clock entries as TTL-expired
  let t = opts.startClock ?? Date.now();
  const kv = opts.kv ?? memKV();
  const serverSpy: ServerSpy = { streamCalls: 0, completeCalls: 0, lastSignal: null };
  const localSpy: LocalSpy = { loadCalls: 0, streamCalls: 0, completeCalls: 0, interruptCalls: 0 };
  const decisions: DecisionLog[] = [];
  const ludion = await Ludion.create({
    fallback: { url: "https://example.test/v1/chat/completions", model: "server-model" },
    ...(opts.hints ? { hints: opts.hints } : {}),
    onDecision: (log) => decisions.push(log),
    _test: {
      probe: opts.probe ?? DESKTOP,
      kv,
      // every now() call advances 10ms → deterministic nonzero ttft/intervals
      now: () => (t += 10),
      localExecutor: mockLocal(localSpy, opts.localMode),
      serverExecutor: mockServer(serverSpy),
    },
  });
  return { ludion, kv, serverSpy, localSpy, decisions, tick: (ms) => (t += ms) };
}

const MESSAGES = [{ role: "user" as const, content: "hello there" }];

async function drain(stream: AsyncIterable<ChatCompletionChunk>): Promise<string> {
  let text = "";
  for await (const c of stream) text += c.choices[0]?.delta?.content ?? "";
  return text;
}

// --- tests --------------------------------------------------------------------

describe("Ludion facade: routing + execution", () => {
  it("desktop → local stream (R4), measurements + onDecision once (acceptance 1)", async () => {
    const h = await harness({});
    const stream = await h.ludion.chat.completions.create({
      messages: MESSAGES,
      max_tokens: 64,
      stream: true,
    });
    const log = stream._ludion;
    expect(log.target).toBe("local");
    expect(log.rule_id).toBe("R4");
    expect(log.policy_version).toBe("v0-20260610");
    expect(log.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(log.completed).toBe(false); // decision-time object, mutated on completion (A-6)

    expect(await drain(stream)).toBe("loc-aloc-b");
    expect(log.completed).toBe(true);
    expect(log.ttft_ms).not.toBeNull();
    expect(log.tps).not.toBeNull();
    expect(log.tokens_in).toBe(11);
    expect(log.tokens_out).toBe(7);
    expect(log.tokens_source).toBe("exact");
    expect(log.degraded).toBeNull();
    expect(h.decisions).toEqual([log]); // exactly once, same (mutated) object
    expect(h.serverSpy.streamCalls).toBe(0);
    // tombstone cleared after success
    expect(h.kv.getItem("ludion.router.tombstone.v1")).toBeNull();
  });

  it("_ludion is non-enumerable (A-6 / acceptance 8)", async () => {
    const h = await harness({});
    const stream = await h.ludion.chat.completions.create({
      messages: MESSAGES,
      stream: true,
    });
    expect(Object.keys(stream)).not.toContain("_ludion");
    await drain(stream);
  });

  it("iPhone → server (R3) with zero local engine involvement (acceptance 2)", async () => {
    const h = await harness({ probe: IPHONE });
    const stream = await h.ludion.chat.completions.create({
      messages: MESSAGES,
      stream: true,
    });
    expect(await drain(stream)).toBe("srv-asrv-b");
    expect(stream._ludion.rule_id).toBe("R2"); // no webgpu matches before R3 on this probe
    expect(stream._ludion.target).toBe("server");
    expect(h.localSpy.loadCalls).toBe(0);
    expect(h.localSpy.streamCalls).toBe(0);
  });

  it("iPhone with WebGPU-looking probe still hits R3", async () => {
    const h = await harness({ probe: probeOf({ os_class: "ios-webkit" }) });
    const res = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    await drain(res);
    expect(res._ludion.rule_id).toBe("R3");
    expect(h.localSpy.loadCalls).toBe(0);
  });

  it("non-stream local success returns OpenAI-shaped completion + _ludion", async () => {
    const h = await harness({});
    const res = await h.ludion.chat.completions.create({ messages: MESSAGES });
    expect(res.choices[0]?.message.content).toBe("local says hi");
    expect(res._ludion.target).toBe("local");
    expect(res._ludion.completed).toBe(true);
    expect(Object.keys(res)).not.toContain("_ludion");
    expect(h.decisions.length).toBe(1);
  });
});

describe("degrade (A-2 two-branch)", () => {
  it("stream: pre-first-token local failure → transparent server retry (acceptance 6)", async () => {
    const h = await harness({ localMode: { kind: "fail-pre-token", error: new Error("boom") } });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("srv-asrv-b"); // consumer sees a seamless stream
    const log = stream._ludion;
    expect(log.degraded).toBe("local→server");
    expect(log.degraded_failed).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.model).toBe("server-model");
    expect(log.rule_id).toBe("R4"); // decision rule is preserved
    expect(h.decisions.length).toBe(1);
    // caught failure = +0.5 strike
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0.5);
  });

  it("stream: load failure also degrades transparently", async () => {
    const h = await harness({ localMode: { kind: "fail-load", error: new Error("oom-ish") } });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("srv-asrv-b");
    expect(stream._ludion.degraded).toBe("local→server");
  });

  it("stream: post-first-token failure ends the stream with a typed error (A-2)", async () => {
    const h = await harness({ localMode: { kind: "fail-mid-stream", error: new Error("died") } });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    let text = "";
    await expect(async () => {
      for await (const c of stream) text += c.choices[0]?.delta?.content ?? "";
    }).rejects.toThrow(LudionMidStreamError);
    expect(text).toBe("loc-a"); // yielded tokens cannot be recalled
    const log = stream._ludion;
    expect(log.degraded_failed).toBe(true);
    expect(log.degraded).toBeNull();
    expect(log.completed).toBe(false);
    expect(log.error).toContain("after first token");
    expect(h.serverSpy.streamCalls).toBe(0); // explicitly NO server continuation (binding resolution 2)
    expect(h.decisions.length).toBe(1);
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0.5);
  });

  it("non-stream: local failure always retries transparently on server", async () => {
    const h = await harness({ localMode: { kind: "fail-load", error: new Error("boom") } });
    const res = await h.ludion.chat.completions.create({ messages: MESSAGES });
    expect(res.choices[0]?.message.content).toBe("server says hi");
    expect(res._ludion.degraded).toBe("local→server");
    expect(h.decisions.length).toBe(1);
  });

  it("B-3: context-window overflow degrades but adds NO strike", async () => {
    class ContextWindowSizeExceededError extends Error {}
    const h = await harness({
      localMode: { kind: "fail-pre-token", error: new ContextWindowSizeExceededError("ctx") },
    });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("srv-asrv-b");
    expect(stream._ludion.degraded).toBe("local→server");
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0);
  });
});

describe("strikes across sessions (acceptance 4)", () => {
  it("simulated kill: surviving tombstone routes next session to server without load attempt", async () => {
    const kv = memKV();
    // session 1 "died" mid-generate: tombstone survives
    new StrikeStore(kv).writeTombstone(DEFAULT_LOCAL_MODEL, "generate");
    // session 2 boots
    const h = await harness({ kv });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("srv-asrv-b");
    expect(stream._ludion.rule_id).toBe("R4+strike");
    expect(stream._ludion.target).toBe("server");
    expect(stream._ludion.strike_state[DEFAULT_LOCAL_MODEL]).toBe(1);
    expect(h.localSpy.loadCalls).toBe(0);
  });

  it("TTL expiry restores local eligibility", async () => {
    const kv = memKV();
    new StrikeStore(kv).writeTombstone(DEFAULT_LOCAL_MODEL, "load");
    const h = await harness({ kv });
    h.tick(DEFAULT_STRIKE_TTL_MS + 1);
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("loc-aloc-b");
    expect(stream._ludion.rule_id).toBe("R4");
  });
});

describe("privacy (B-1 / B-2, acceptance 5)", () => {
  it("privacy on iPhone probe throws LudionPrivacyUnroutable, no server call", async () => {
    const h = await harness({ probe: probeOf({ os_class: "ios-webkit" }), hints: { privacy: true } });
    await expect(
      h.ludion.chat.completions.create({ messages: MESSAGES, stream: true }),
    ).rejects.toThrow(LudionPrivacyUnroutable);
    expect(h.serverSpy.streamCalls).toBe(0);
    expect(h.serverSpy.completeCalls).toBe(0);
    expect(h.localSpy.loadCalls).toBe(0);
    // decision log still emitted, marked unroutable
    expect(h.decisions.length).toBe(1);
    expect(h.decisions[0]?.target).toBe("unroutable");
    expect(h.decisions[0]?.rule_id).toBe("R3");
  });

  it("B-1: privacy forces local on Android beyond R5 request limits", async () => {
    const h = await harness({ probe: probeOf({ os_class: "android-chromium" }) });
    const stream = await h.ludion.chat.completions.create({
      messages: [{ role: "user", content: "x".repeat(2000) }], // est 500 > 200
      stream: true,
      ludion: { privacy: true },
    });
    expect(await drain(stream)).toBe("loc-aloc-b");
    expect(stream._ludion.rule_id).toBe("R5+privacy");
    expect(stream._ludion.target).toBe("local");
  });

  it("B-2: privacy × struck model throws instead of forcing local", async () => {
    const kv = memKV();
    new StrikeStore(kv).writeTombstone(DEFAULT_LOCAL_MODEL, "generate");
    const h = await harness({ kv, hints: { privacy: true } });
    await expect(
      h.ludion.chat.completions.create({ messages: MESSAGES, stream: true }),
    ).rejects.toThrow(LudionPrivacyUnroutable);
  });

  it("privacy: local failure does NOT fall back to server (stream)", async () => {
    const h = await harness({
      localMode: { kind: "fail-pre-token", error: new Error("boom") },
      hints: { privacy: true },
    });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    await expect(drain(stream)).rejects.toThrow("boom");
    expect(h.serverSpy.streamCalls).toBe(0);
    expect(stream._ludion.degraded).toBeNull();
    expect(h.decisions.length).toBe(1);
  });
});

describe("Phase 0: local-only mode (fallback omitted)", () => {
  // No `fallback` AND no injected serverExecutor (an injected executor counts
  // as a configured server).
  async function localOnly(opts: { probe?: RouterProbe; localMode?: LocalMode } = {}): Promise<{
    ludion: Ludion;
    kv: KV;
    localSpy: LocalSpy;
    decisions: DecisionLog[];
  }> {
    let t = Date.now();
    const kv = memKV();
    const localSpy: LocalSpy = { loadCalls: 0, streamCalls: 0, completeCalls: 0, interruptCalls: 0 };
    const decisions: DecisionLog[] = [];
    const ludion = await Ludion.create({
      onDecision: (log) => decisions.push(log),
      _test: {
        probe: opts.probe ?? DESKTOP,
        kv,
        now: () => (t += 10),
        localExecutor: mockLocal(localSpy, opts.localMode),
      },
    });
    return { ludion, kv, localSpy, decisions };
  }

  it("Ludion.create() is callable with zero arguments", async () => {
    const ludion = await Ludion.create();
    expect(ludion.probe).toBeDefined(); // node fallback probe, never throws
    expect(typeof ludion.chat.completions.create).toBe("function");
  });

  it("local route works end-to-end with no fallback configured", async () => {
    const h = await localOnly({});
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    expect(await drain(stream)).toBe("loc-aloc-b");
    expect(stream._ludion.rule_id).toBe("R4");
    expect(stream._ludion.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(stream._ludion.completed).toBe(true);
  });

  it("server route throws LudionNoFallbackConfigured at decision time, log emitted", async () => {
    const h = await localOnly({ probe: IPHONE });
    let caught: unknown;
    try {
      await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LudionNoFallbackConfigured);
    expect((caught as LudionNoFallbackConfigured).rule_id).toBe("R2");
    expect(h.localSpy.loadCalls).toBe(0); // engine never touched
    expect(h.decisions.length).toBe(1);
    expect(h.decisions[0]?.error).toContain("LudionNoFallbackConfigured");
    expect(h.decisions[0]?.target).toBe("server"); // honest: policy chose server
  });

  it("non-stream degrade with no fallback → typed error, strike still recorded", async () => {
    const h = await localOnly({ localMode: { kind: "fail-load", error: new Error("boom") } });
    await expect(h.ludion.chat.completions.create({ messages: MESSAGES })).rejects.toThrow(
      LudionNoFallbackConfigured,
    );
    expect(h.decisions.length).toBe(1);
    expect(h.decisions[0]?.degraded).toBeNull(); // no retry happened
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0.5);
  });

  it("stream pre-first-token degrade with no fallback → typed error on the stream", async () => {
    const h = await localOnly({ localMode: { kind: "fail-pre-token", error: new Error("boom") } });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    await expect(drain(stream)).rejects.toThrow(LudionNoFallbackConfigured);
    expect(stream._ludion.degraded).toBeNull();
    expect(stream._ludion.error).toContain("LudionNoFallbackConfigured");
    expect(h.decisions.length).toBe(1);
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0.5);
  });

  it("error message tells the user the fix (proxy, not client-side key)", () => {
    const err = new LudionNoFallbackConfigured("R6");
    expect(err.message).toContain("R6");
    expect(err.message).toContain("fallback: { url, model }");
    expect(err.message).toContain("proxy");
  });
});

describe("cancellation (Q3)", () => {
  it("consumer break on local stream → interruptGenerate, tombstone cleared, log once", async () => {
    const h = await harness({ localMode: { kind: "hang-after-first" } });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    for await (const c of stream) {
      if (c.choices[0]?.delta?.content) break; // stop after first token
    }
    expect(h.localSpy.interruptCalls).toBe(1);
    expect(stream._ludion.cancelled).toBe(true);
    expect(stream._ludion.completed).toBe(false);
    expect(h.kv.getItem("ludion.router.tombstone.v1")).toBeNull();
    expect(h.decisions.length).toBe(1);
    // cancellation is not a failure: no strike
    expect(new StrikeStore(h.kv).getScore(DEFAULT_LOCAL_MODEL)).toBe(0);
  });

  it("consumer break on server stream → fetch aborted", async () => {
    const h = await harness({ probe: IPHONE });
    const stream = await h.ludion.chat.completions.create({ messages: MESSAGES, stream: true });
    for await (const c of stream) {
      if (c.choices[0]?.delta?.content) break;
    }
    expect(h.serverSpy.lastSignal?.aborted).toBe(true);
    expect(stream._ludion.cancelled).toBe(true);
  });
});
