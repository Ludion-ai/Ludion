import { describe, expect, it } from "vitest";
import { handleRelay, type FetchLike, type RelayEnv } from "../src/relay";

const ORIGIN = "https://app.example";

function baseEnv(overrides: Partial<RelayEnv> = {}): RelayEnv {
  return {
    PROVIDER_API_KEY: "sk-test-secret",
    UPSTREAM_BASE_URL: "https://upstream.example/v1",
    ALLOWED_ORIGINS: `${ORIGIN},https://other.example`,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://relay.example/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Captures what the relay sent upstream, and returns a canned OpenAI response. */
function captureUpstream(response: Response): { fetch: FetchLike; seen: () => { url: string; init: RequestInit } } {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchLike: FetchLike = async (url, init) => {
    captured = { url, init };
    return response;
  };
  return {
    fetch: fetchLike,
    seen: () => {
      if (captured === null) throw new Error("upstream was never called");
      return captured;
    },
  };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A stream whose chunks are pushed manually so a test can read one before the next exists. */
function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (s) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
  };
}

describe("CORS", () => {
  it("answers preflight from an allowed origin with reflected origin and POST method", async () => {
    const res = await handleRelay(
      new Request("https://relay.example/chat/completions", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
      baseEnv(),
      captureUpstream(jsonResponse({})).fetch,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("reflects no CORS origin for a foreign Origin and refuses the POST", async () => {
    const up = captureUpstream(jsonResponse({}));
    const req = new Request("https://relay.example/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    const res = await handleRelay(req, baseEnv(), up.fetch);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("provider key custody", () => {
  it("accepts a request with NO provider key and injects the secret upstream", async () => {
    const up = captureUpstream(jsonResponse({ id: "x", choices: [] }));
    const res = await handleRelay(post({ model: "gpt", messages: [] }), baseEnv(), up.fetch);

    expect(res.status).toBe(200);
    // The browser sent no Authorization; the relay injects the secret.
    const auth = new Headers(up.seen().init.headers).get("authorization");
    expect(auth).toBe("Bearer sk-test-secret");
    // Upstream URL is base + /chat/completions.
    expect(up.seen().url).toBe("https://upstream.example/v1/chat/completions");
  });

  it("never forwards a browser-sent Authorization upstream (relay token is dropped)", async () => {
    const up = captureUpstream(jsonResponse({}));
    await handleRelay(
      post({ model: "gpt", messages: [] }, { Authorization: "Bearer sk-LEAK-from-browser" }),
      baseEnv({ RELAY_TOKEN: "relay-tok" }),
      up.fetch,
    );
    // Wrong relay token → request is refused before upstream is even called.
    expect(() => up.seen()).toThrow();
  });

  it("with RELAY_TOKEN set: correct token passes, and only the provider key reaches upstream", async () => {
    const up = captureUpstream(jsonResponse({ ok: true }));
    const res = await handleRelay(
      post({ model: "gpt", messages: [] }, { Authorization: "Bearer relay-tok" }),
      baseEnv({ RELAY_TOKEN: "relay-tok" }),
      up.fetch,
    );
    expect(res.status).toBe(200);
    const auth = new Headers(up.seen().init.headers).get("authorization");
    expect(auth).toBe("Bearer sk-test-secret");
    expect(auth).not.toContain("relay-tok");
  });

  it("with RELAY_TOKEN set: missing token is rejected with 401", async () => {
    const up = captureUpstream(jsonResponse({}));
    const res = await handleRelay(
      post({ model: "gpt", messages: [] }),
      baseEnv({ RELAY_TOKEN: "relay-tok" }),
      up.fetch,
    );
    expect(res.status).toBe(401);
    expect(() => up.seen()).toThrow();
  });

  it("returns 500 if the relay has no provider key secret", async () => {
    const up = captureUpstream(jsonResponse({}));
    const res = await handleRelay(
      post({ model: "gpt", messages: [] }),
      baseEnv({ PROVIDER_API_KEY: "" }),
      up.fetch,
    );
    expect(res.status).toBe(500);
  });
});

describe("OpenAI-shaped passthrough", () => {
  it("passes the upstream JSON body and status through unchanged", async () => {
    const payload = { id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0 }] };
    const up = captureUpstream(jsonResponse(payload));
    const res = await handleRelay(post({ model: "gpt", messages: [] }), baseEnv(), up.fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("passes the upstream non-2xx status and body through (so the router sees the error)", async () => {
    const up = captureUpstream(
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await handleRelay(post({ model: "gpt", messages: [] }), baseEnv(), up.fetch);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate limited" });
  });
});

describe("streaming", () => {
  it("passes SSE through token-by-token without buffering", async () => {
    const ctl = controlledStream();
    const up = captureUpstream(
      new Response(ctl.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    // The relay must return as soon as the upstream responds — before the stream
    // is finished — proving it does not buffer the full body.
    const res = await handleRelay(post({ model: "gpt", messages: [], stream: true }), baseEnv(), up.fetch);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    ctl.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    const first = await reader.read();
    expect(dec.decode(first.value)).toContain('"content":"Hel"');

    ctl.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    const second = await reader.read();
    expect(dec.decode(second.value)).toContain('"content":"lo"');

    ctl.push("data: [DONE]\n\n");
    ctl.close();
    const third = await reader.read();
    expect(dec.decode(third.value)).toContain("[DONE]");
    const end = await reader.read();
    expect(end.done).toBe(true);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const up = captureUpstream(jsonResponse({}));
    const res = await handleRelay(
      new Request("https://relay.example/nope", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }),
      baseEnv(),
      up.fetch,
    );
    expect(res.status).toBe(404);
  });

  it("405s a GET to the relay path", async () => {
    const up = captureUpstream(jsonResponse({}));
    const res = await handleRelay(
      new Request("https://relay.example/chat/completions", { method: "GET", headers: { Origin: ORIGIN } }),
      baseEnv(),
      up.fetch,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
