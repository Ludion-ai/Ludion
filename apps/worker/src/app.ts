import { Hono } from "hono";
import { mountApi } from "./api.ts";
import { mountAuth } from "./auth.ts";
import { defaultDeps, type Deps } from "./deps.ts";
import { handleMcp } from "./mcp/server.ts";

export interface Env {
  ASSETS: Fetcher;
  SITE_URL: string;
  SOURCE_CHECK_LIMITER: RateLimit;
  // Secrets (wrangler secret put; never logged).
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

export type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const TEACHER_PATH = /^\/@([A-Za-z0-9-]{1,39})\/?$/;

export function createApp(deps: Deps = defaultDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Log route, status, latency, request id. Never cookies, tokens, secrets, or authorization headers.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    const started = Date.now();
    await next();
    // Responses from env.ASSETS have immutable headers; copy before adding ours.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    const path = new URL(c.req.url).pathname;
    if (/^\/(mcp|api|auth)(\/|$)/.test(path)) {
      console.log(JSON.stringify({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, ms: Date.now() - started, rid: requestId }));
    }
  });

  // MCP over Streamable HTTP, stateless; OPTIONS for CORS preflight from browser-based clients.
  app.on(["GET", "POST", "DELETE", "OPTIONS"], "/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext));

  mountAuth(app, deps);
  mountApi(app, deps);

  // /@<login> serves the teacher page at the lowercase login. Unknown teachers get the 404 page.
  app.get("*", async (c, next) => {
    const m = TEACHER_PATH.exec(new URL(c.req.url).pathname);
    if (!m) return next();
    const target = new URL(`/teachers/${m[1]!.toLowerCase()}/`, c.req.url);
    return c.env.ASSETS.fetch(new Request(target, c.req.raw));
  });

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
