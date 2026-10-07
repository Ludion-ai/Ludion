// GitHub sign-in: /auth/login, /auth/callback, /auth/logout (worker.md, Sign-in and session).
import type { Hono } from "hono";
import type { AppEnv, Env } from "./app.ts";
import type { Deps } from "./deps.ts";
import { apiError, csrfProblem, getCookie, json, setCookie } from "./http.ts";
import {
  OAUTH_COOKIE, OAUTH_SECONDS, SESSION_COOKIE, SESSION_SECONDS,
  randomToken, sameText, sign, verify, type Session,
} from "./session.ts";

const ACCOUNT_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const UA = "Ludion (+https://ludion.ai)";

/** `next` must start with "/" and not "//" (nor "/\", which browsers read as "//"); otherwise "/". */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f]/.test(next)) return "/";
  return next;
}

export async function currentSession(request: Request, env: Env, nowMs: number): Promise<Session | undefined> {
  return verify<Session>(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET, Math.floor(nowMs / 1000));
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export function mountAuth(app: Hono<AppEnv>, deps: Deps): void {
  app.get("/auth/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    const state = randomToken(32);
    const nowSeconds = Math.floor(deps.now() / 1000);
    const cookie = await sign({ state, next, exp: nowSeconds + OAUTH_SECONDS }, c.env.SESSION_SECRET);
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", `${c.env.SITE_URL}/auth/callback`);
    authorize.searchParams.set("state", state);
    return redirect(authorize.href, [setCookie(OAUTH_COOKIE, cookie, OAUTH_SECONDS, "/auth")]);
  });

  app.get("/auth/callback", async (c) => {
    const nowMs = deps.now();
    const saved = await verify<{ state: string; next: string; exp: number }>(getCookie(c.req.raw, OAUTH_COOKIE), c.env.SESSION_SECRET, Math.floor(nowMs / 1000));
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const clearOauth = setCookie(OAUTH_COOKIE, "", 0, "/auth");
    if (!saved || !state || !sameText(state, saved.state) || !code) {
      return apiError(400, "bad_state", "This sign-in link expired or was started in another browser. Start again from https://ludion.ai/teach.");
    }

    let profile: { login: string; id: number; avatar_url: string; created_at: string };
    try {
      const tokenRes = await deps.fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${c.env.SITE_URL}/auth/callback` }),
      });
      const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
      if (!tokenRes.ok || !token) throw new Error("no access token");
      // One call for the profile; the user token is then dropped and never stored.
      const userRes = await deps.fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!userRes.ok) throw new Error(`GET /user: HTTP ${userRes.status}`);
      profile = (await userRes.json()) as typeof profile;
    } catch {
      return redirect("/teach?error=github_error", [clearOauth]);
    }

    if (nowMs - Date.parse(profile.created_at) < ACCOUNT_MIN_AGE_MS) {
      return redirect("/teach?error=account_too_new", [clearOauth]);
    }
    const session: Session = { login: profile.login, id: profile.id, avatar_url: profile.avatar_url, exp: Math.floor(nowMs / 1000) + SESSION_SECONDS };
    return redirect(safeNext(saved.next), [clearOauth, setCookie(SESSION_COOKIE, await sign(session, c.env.SESSION_SECRET), SESSION_SECONDS)]);
  });

  app.post("/auth/logout", async (c) => {
    const session = await currentSession(c.req.raw, c.env, deps.now());
    if (!session) return apiError(401, "signin_required", "You are not signed in.", { signin_url: `${c.env.SITE_URL}/auth/login?next=/teach` });
    const csrf = csrfProblem(c.req.raw, c.env.SITE_URL);
    if (csrf === "forbidden_origin") return apiError(403, "forbidden_origin", "This request did not come from ludion.ai. Sign out from https://ludion.ai.");
    if (csrf === "bad_request") return apiError(400, "bad_request", "Send this request as JSON with Content-Type: application/json.");
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  });
}
