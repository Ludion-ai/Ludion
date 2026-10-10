import { Hono } from "hono";
import { handleMcp } from "./mcp/server.ts";

export interface Env {
  ASSETS: Fetcher;
  SITE_URL: string;
}

const TEACHER_PATH = /^\/@([A-Za-z0-9-]{1,39})\/?$/;

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    await next();
    // Responses from env.ASSETS have immutable headers; copy before adding ours.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  // MCP over Streamable HTTP, stateless; OPTIONS for CORS preflight from browser-based clients.
  app.on(["GET", "POST", "DELETE", "OPTIONS"], "/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext));

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
