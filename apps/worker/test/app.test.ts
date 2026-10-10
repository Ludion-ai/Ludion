// Runs inside workerd (@cloudflare/vitest-plugin) against the Worker from wrangler.jsonc and the built site.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://ludion.ai${path}`, init));

interface IndexJson {
  lessons: { id: string; teacher: string }[];
  teachers: Record<string, { login: string }>;
}

async function builtIndex(): Promise<IndexJson> {
  const res = await get("/index.json");
  expect(res.status).toBe(200);
  return res.json();
}

describe("worker", () => {
  it("serves index.json to any origin", async () => {
    const res = await get("/index.json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await res.json() as { version: number }).version).toBe(1);
  });

  it("serves every lesson page in the index", async () => {
    const { lessons } = await builtIndex();
    for (const l of lessons) {
      const res = await get(`/lessons/${l.id}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`/lessons/${l.id}/`);
    }
  });

  it("redirects a lesson URL without the trailing slash", async () => {
    const { lessons } = await builtIndex();
    if (lessons.length === 0) return;
    const res = await get(`/lessons/${lessons[0]!.id}`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(`/lessons/${lessons[0]!.id}/`);
  });

  it("serves /@<login> in any case from the lowercase teacher page", async () => {
    const { teachers } = await builtIndex();
    for (const { login } of Object.values(teachers)) {
      for (const variant of [login, login.toUpperCase(), `${login.toLowerCase()}/`]) {
        const res = await get(`/@${variant}`);
        expect(res.status, variant).toBe(200);
        expect(await res.text()).toContain(`@${login}`);
      }
    }
  });

  it("gives the 404 page for an unknown teacher or an invalid login", async () => {
    for (const path of ["/@nobody-has-this-login-0", "/@bad_login!", "/no-such-page/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("No page here.");
    }
  });

  it("sets nosniff on Worker responses and static assets", async () => {
    const { teachers } = await builtIndex();
    const login = Object.values(teachers)[0]?.login ?? "nobody";
    for (const path of ["/", "/index.json", `/@${login}`, "/@nobody-has-this-login-0"]) {
      expect((await get(path)).headers.get("X-Content-Type-Options"), path).toBe("nosniff");
    }
  });

  it("sends HSTS for a year on every response, without includeSubDomains or preload", async () => {
    for (const path of ["/", "/index.json", "/mcp", "/@nobody-has-this-login-0"]) {
      expect((await get(path)).headers.get("Strict-Transport-Security"), path).toBe("max-age=31536000");
    }
  });
});
