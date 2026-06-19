import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest, type FetchLike, type KVLike, type WorkspaceEnv } from "../src/handler";
import { SESSION_COOKIE, signSession, type Session } from "../src/session";

/** In-memory KV mock (the collector's test convention). */
class MemKV implements KVLike {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const SESSION_SECRET = "test-session-secret-xxxxxxxxxxxxxxxx";
const NOW = 1_900_000_000_000;

function baseEnv(kv: KVLike, fetchImpl?: FetchLike): { env: WorkspaceEnv; deps: { fetch: FetchLike; now: () => number; randomState: () => string } } {
  const env: WorkspaceEnv = {
    WORKSPACE_KV: kv,
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    GITHUB_OAUTH_BASE: "https://github.test",
    GITHUB_API_BASE: "https://api.github.test",
  };
  const deps = {
    fetch: fetchImpl ?? (async () => new Response("unexpected", { status: 500 })),
    now: () => NOW,
    randomState: () => "fixed-state-123",
  };
  return { env, deps };
}

async function sessionCookie(uid = "42", login = "octocat"): Promise<string> {
  const s: Session = { uid, login, iat: NOW, exp: NOW + 1_000_000 };
  const token = await signSession(s, SESSION_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, init);
}

describe("auth: login", () => {
  it("redirects to GitHub authorize with state cookie", async () => {
    const { env, deps } = baseEnv(new MemKV());
    const res = await handleRequest(req("/auth/login"), env, deps);
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("https://github.test/login/oauth/authorize");
    expect(loc).toContain("client_id=client-id");
    expect(loc).toContain("redirect_uri=https%3A%2F%2Fapp.test%2Fauth%2Fcallback");
    expect(loc).toContain("state=fixed-state-123");
    expect(res.headers.get("Set-Cookie")).toContain("ludion_oauth_state=fixed-state-123");
    expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
  });
});

describe("auth: callback (mocked GitHub exchange)", () => {
  function githubFetch(): FetchLike {
    return async (url) => {
      if (url.startsWith("https://github.test/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_secret_token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.github.test/user")) {
        return new Response(JSON.stringify({ id: 42, login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
  }

  it("exchanges the code, mints a session cookie, and discards the GitHub token", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(url);
      return githubFetch()(url, init);
    };
    const { env, deps } = baseEnv(new MemKV(), fetchImpl);
    const res = await handleRequest(
      req("/auth/callback?code=abc&state=fixed-state-123", {
        headers: { Cookie: "ludion_oauth_state=fixed-state-123" },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(302);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    // The GitHub access token must never appear in a cookie.
    expect(cookies.join(" ")).not.toContain("gho_secret_token");
    // State cookie cleared.
    expect(cookies.some((c) => c.startsWith("ludion_oauth_state=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("rejects a mismatched OAuth state with 400 and never calls GitHub", async () => {
    let called = false;
    const fetchImpl: FetchLike = async (url, init) => {
      called = true;
      return githubFetch()(url, init);
    };
    const { env, deps } = baseEnv(new MemKV(), fetchImpl);
    const res = await handleRequest(
      req("/auth/callback?code=abc&state=evil", {
        headers: { Cookie: "ludion_oauth_state=fixed-state-123" },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("auth: logout", () => {
  it("clears the session cookie", async () => {
    const { env, deps } = baseEnv(new MemKV());
    const res = await handleRequest(req("/auth/logout", { method: "POST" }), env, deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("/api/* auth gate", () => {
  it("rejects unauthenticated /api/config with 401", async () => {
    const { env, deps } = baseEnv(new MemKV());
    const res = await handleRequest(req("/api/config"), env, deps);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered session cookie with 401", async () => {
    const { env, deps } = baseEnv(new MemKV());
    const res = await handleRequest(
      req("/api/config", { headers: { Cookie: `${SESSION_COOKIE}=not.a.valid.token` } }),
      env,
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown /api route with 401 when unauthenticated (no shape leak)", async () => {
    const { env, deps } = baseEnv(new MemKV());
    const res = await handleRequest(req("/api/whatever"), env, deps);
    expect(res.status).toBe(401);
  });
});

describe("/api/config round-trip", () => {
  let kv: MemKV;
  beforeEach(() => {
    kv = new MemKV();
  });

  it("GET returns an empty default for a new user", async () => {
    const { env, deps } = baseEnv(kv);
    const res = await handleRequest(req("/api/config", { headers: { Cookie: await sessionCookie() } }), env, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config_version: 1, fallback: {} });
  });

  it("PUT then GET is lossless for allowed fields", async () => {
    const { env, deps } = baseEnv(kv);
    const payload = {
      config_version: 1,
      fallback: { baseURL: "https://relay.example.workers.dev", model: "gpt-4o-mini" },
      relayUrl: "https://relay.example.workers.dev",
    };
    const put = await handleRequest(
      req("/api/config", {
        method: "PUT",
        headers: { Cookie: await sessionCookie(), "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      deps,
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(payload);

    const get = await handleRequest(req("/api/config", { headers: { Cookie: await sessionCookie() } }), env, deps);
    expect(await get.json()).toEqual(payload);
  });

  it("scopes config per user id", async () => {
    const { env, deps } = baseEnv(kv);
    await handleRequest(
      req("/api/config", {
        method: "PUT",
        headers: { Cookie: await sessionCookie("1", "alice"), "content-type": "application/json" },
        body: JSON.stringify({ fallback: { model: "gpt-4o" } }),
      }),
      env,
      deps,
    );
    const bob = await handleRequest(
      req("/api/config", { headers: { Cookie: await sessionCookie("2", "bob") } }),
      env,
      deps,
    );
    expect(await bob.json()).toEqual({ config_version: 1, fallback: {} });
  });
});

describe("storage invariant: secret/content rejection", () => {
  let kv: MemKV;
  beforeEach(() => {
    kv = new MemKV();
  });

  async function put(body: unknown): Promise<Response> {
    const { env, deps } = baseEnv(kv);
    return handleRequest(
      req("/api/config", {
        method: "PUT",
        headers: { Cookie: await sessionCookie(), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
  }

  it("rejects a provider apiKey field with 400 and stores nothing", async () => {
    const res = await put({ fallback: { model: "gpt-4o", apiKey: "sk-leak" } });
    expect(res.status).toBe(400);
    expect(kv.store.size).toBe(0);
  });

  it("rejects a relay token field with 400", async () => {
    const res = await put({ fallback: { model: "gpt-4o" }, relayToken: "tok" });
    expect(res.status).toBe(400);
  });

  it("rejects message/content fields with 400", async () => {
    expect((await put({ messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect((await put({ fallback: { model: "x" }, content: "secret" })).status).toBe(400);
  });

  it("rejects an unknown top-level field with 400", async () => {
    const res = await put({ fallback: { model: "x" }, extra: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-http baseURL with 400", async () => {
    const res = await put({ fallback: { baseURL: "javascript:alert(1)", model: "x" } });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const { env, deps } = baseEnv(kv);
    const res = await handleRequest(
      req("/api/config", {
        method: "PUT",
        headers: { Cookie: await sessionCookie(), "content-type": "application/json" },
        body: "{not json",
      }),
      env,
      deps,
    );
    expect(res.status).toBe(400);
  });
});
