/**
 * Ludion workspace backend — Workspace 2a (auth + config persistence skeleton).
 *
 * Pure request handler: platform bindings (`env`) and the outbound GitHub call
 * (`deps.fetch`) are injected so the whole flow is unit-testable on in-memory
 * mocks (the collector's convention). It runs unchanged as a standalone Worker
 * (src/index.ts) for `wrangler dev`, and behind same-origin Pages Functions
 * (demo/functions/*) in production.
 *
 * STORAGE INVARIANT (§1): the only thing written to KV is a validated, non-secret
 * StoredConfig. The GitHub access token is used once in the callback to read the
 * user id, then discarded — never stored, never logged. No prompt/output content
 * ever reaches this server.
 */
import {
  emptyStoredConfig,
  validateStoredConfig,
  WorkspaceConfigError,
  type StoredConfig,
} from "./schema";
import {
  OAUTH_STATE_COOKIE,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  serializeCookie,
  signSession,
  verifySession,
  type Session,
} from "./session";

/** Minimal slice of KVNamespace the store uses (KVNamespace satisfies this). */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface WorkspaceEnv {
  /** Per-user config store, keyed `user:{uid}`. */
  WORKSPACE_KV: KVLike;
  /** Pages secret (Lattice sets it). GitHub OAuth app client id. */
  GITHUB_CLIENT_ID: string;
  /** Pages secret. GitHub OAuth app client secret — used only in the callback. */
  GITHUB_CLIENT_SECRET: string;
  /** Pages secret. HMAC key that signs the session cookie. */
  SESSION_SECRET: string;
  /** Override for tests; default "https://github.com". */
  GITHUB_OAUTH_BASE?: string;
  /** Override for tests; default "https://api.github.com". */
  GITHUB_API_BASE?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HandlerDeps {
  fetch?: FetchLike;
  now?: () => number;
  randomState?: () => string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function githubOAuthBase(env: WorkspaceEnv): string {
  return env.GITHUB_OAUTH_BASE ?? "https://github.com";
}
function githubApiBase(env: WorkspaceEnv): string {
  return env.GITHUB_API_BASE ?? "https://api.github.com";
}

function configKey(uid: string): string {
  return `user:${uid}`;
}

async function currentSession(
  request: Request,
  env: WorkspaceEnv,
  nowMs: number,
): Promise<Session | null> {
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (token === undefined) return null;
  return verifySession(token, env.SESSION_SECRET, nowMs);
}

// --- /auth/* ----------------------------------------------------------------

function handleLogin(request: Request, env: WorkspaceEnv, deps: Required<HandlerDeps>): Response {
  const origin = new URL(request.url).origin;
  const state = deps.randomState();
  const authorize = new URL(`${githubOAuthBase(env)}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 600 }),
    },
  });
}

async function handleCallback(
  request: Request,
  env: WorkspaceEnv,
  deps: Required<HandlerDeps>,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = parseCookies(request.headers.get("Cookie"))[OAUTH_STATE_COOKIE];

  if (code === null || state === null || stateCookie === undefined || state !== stateCookie) {
    return errorResponse(400, "bad_oauth_state", "missing or mismatched OAuth state");
  }

  // Exchange the code for an access token. The token is used only below and is
  // never stored or logged.
  const tokenRes = await deps.fetch(`${githubOAuthBase(env)}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return errorResponse(401, "oauth_exchange_failed", "GitHub token exchange failed");
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenBody.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return errorResponse(401, "oauth_no_token", "GitHub returned no access token");
  }

  const userRes = await deps.fetch(`${githubApiBase(env)}/user`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "ludion-workspace",
    },
  });
  if (!userRes.ok) return errorResponse(401, "github_user_failed", "could not read GitHub user");
  const user = (await userRes.json()) as { id?: number | string; login?: string };
  if (user.id === undefined || typeof user.login !== "string") {
    return errorResponse(401, "github_user_invalid", "GitHub user response missing id/login");
  }

  const nowMs = deps.now();
  const session: Session = {
    uid: String(user.id),
    login: user.login,
    iat: nowMs,
    exp: nowMs + SESSION_TTL_MS,
  };
  const token = await signSession(session, env.SESSION_SECRET);

  const headers = new Headers({ Location: `${url.origin}/` });
  headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) }),
  );
  // Clear the one-shot state cookie.
  headers.append("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, "", { maxAgeSeconds: 0 }));
  return new Response(null, { status: 302, headers });
}

function handleLogout(request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/`,
      "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0 }),
    },
  });
}

// --- /api/config ------------------------------------------------------------

async function handleConfig(
  request: Request,
  env: WorkspaceEnv,
  session: Session,
): Promise<Response> {
  if (request.method === "GET") {
    const raw = await env.WORKSPACE_KV.get(configKey(session.uid));
    if (raw === null) return json(emptyStoredConfig());
    let parsed: StoredConfig;
    try {
      parsed = JSON.parse(raw) as StoredConfig;
    } catch {
      // Stored value should always be valid JSON we wrote; if not, return empty.
      return json(emptyStoredConfig());
    }
    return json(parsed);
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "body is not valid JSON");
    }
    let validated: StoredConfig;
    try {
      validated = validateStoredConfig(body);
    } catch (e) {
      const message = e instanceof WorkspaceConfigError ? e.message : "invalid config";
      return errorResponse(400, "config_invalid", message);
    }
    await env.WORKSPACE_KV.put(configKey(session.uid), JSON.stringify(validated));
    return json(validated);
  }

  return errorResponse(405, "method_not_allowed", "use GET or PUT");
}

// --- router -----------------------------------------------------------------

export async function handleRequest(
  request: Request,
  env: WorkspaceEnv,
  deps: HandlerDeps = {},
): Promise<Response> {
  const resolved: Required<HandlerDeps> = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? Date.now,
    randomState: deps.randomState ?? (() => crypto.randomUUID()),
  };
  const url = new URL(request.url);

  if (url.pathname === "/auth/login") {
    if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
    return handleLogin(request, env, resolved);
  }
  if (url.pathname === "/auth/callback") {
    if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
    return handleCallback(request, env, resolved);
  }
  if (url.pathname === "/auth/logout") {
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "use POST");
    return handleLogout(request);
  }

  if (url.pathname === "/api/me") {
    if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
    const session = await currentSession(request, env, resolved.now());
    if (session === null) return errorResponse(401, "unauthorized", "login required");
    // Identity only — both fields are non-secret and already inside the signed
    // session cookie. 2b reads this to render the account avatar/initials (the
    // cookie itself is httpOnly, so client JS cannot read it directly).
    return json({ login: session.login, uid: session.uid });
  }

  if (url.pathname === "/api/config") {
    const session = await currentSession(request, env, resolved.now());
    if (session === null) return errorResponse(401, "unauthorized", "login required");
    return handleConfig(request, env, session);
  }

  // /api/* is authenticated-only; an unknown /api route still requires a session
  // so the surface never leaks shape to anonymous callers.
  if (url.pathname.startsWith("/api/")) {
    const session = await currentSession(request, env, resolved.now());
    if (session === null) return errorResponse(401, "unauthorized", "login required");
    return errorResponse(404, "not_found", `no route ${url.pathname}`);
  }

  return errorResponse(404, "not_found", `no route ${url.pathname}`);
}
