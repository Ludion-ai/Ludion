// Runs the Hono app in Node with a stand-in ASSETS binding. Worker-runtime tests
// (@cloudflare/vitest-pool-workers) come with the dynamic routes in steps 4 and 5.
import { describe, expect, it } from "vitest";
import { createApp, type Env } from "../src/app.ts";

const pages: Record<string, string> = {
  "/": "home",
  "/teachers/ludion-ai/": "teacher page",
  "/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W/": "lesson page",
};

function env(): Env & { requested: string[] } {
  const requested: string[] = [];
  const ASSETS = {
    fetch: async (input: Request | string) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      requested.push(path);
      const body = pages[path];
      // Like the real binding: immutable headers.
      const res = body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("404 page", { status: 404 });
      Object.freeze(res.headers);
      return res;
    },
  } as unknown as Fetcher;
  return { ASSETS, SITE_URL: "https://ludion.ai", SOURCE_CHECK_LIMITER: {} as RateLimit, requested };
}

const app = createApp();
const get = (path: string, e = env()) => app.request(`https://ludion.ai${path}`, {}, e);

describe("worker", () => {
  it("serves static assets", async () => {
    const res = await get("/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("lesson page");
  });

  it("serves /@<login> from the lowercase teacher page", async () => {
    const e = env();
    const res = await get("/@Ludion-ai", e);
    expect(await res.text()).toBe("teacher page");
    expect(e.requested).toEqual(["/teachers/ludion-ai/"]);
    expect((await get("/@ludion-ai/")).status).toBe(200);
  });

  it("gives the 404 page for an unknown teacher or an invalid login", async () => {
    expect((await get("/@nobody")).status).toBe(404);
    const e = env();
    expect((await get("/@bad_login!", e)).status).toBe(404);
    expect(e.requested).toEqual(["/@bad_login!"]);
  });

  it("sets nosniff on every response", async () => {
    for (const path of ["/", "/@Ludion-ai", "/missing"]) {
      expect((await get(path)).headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
});
