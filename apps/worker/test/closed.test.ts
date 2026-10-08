// Teaching is closed until every secret is set and well formed and the App's bot id is known (ready.ts), and
// the gaps found in review: account age, the daily count, and what reaches the log.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type Env } from "../src/app.ts";
import { appJwt } from "../src/github.ts";
import { NOT_OPEN, PKCS1_KEY, SHORT_SESSION_SECRET, teachingProblem } from "../src/ready.ts";
import { sign } from "../src/session.ts";
import { BOT_ID, FakeNet, SITE, ctx, github, newUser, page, post, pullsList, request, testEnv } from "./helpers.ts";

const PEP = "https://peps.python.org/pep-0632/";
const QUOTE = "The distutils package is deprecated and slated for removal in Python 3.12.";
const draft = {
  subject: "python",
  version: ">=3.12",
  claim: "Python 3.12 removed the distutils module from the standard library (PEP 632); use setuptools or packaging instead.",
  evidence: [{ run: { runner: "python", code: "import sys\nassert sys.version_info >= (3, 12)" } }, { source: { url: PEP, quote: QUOTE } }],
};
const pep = (net: FakeNet) => page(net, PEP, `<p>${QUOTE}</p>`);

/** One request with some secrets changed; `appBotId: null` leaves the bot id out, as ludion.config.json does today. */
async function withEnv(path: string, over: Partial<Env>, appBotId: number | null = BOT_ID) {
  const app = createApp({ fetch: new FakeNet().fetch, now: () => Date.now(), appBotId: appBotId ?? undefined });
  return app.request(`${SITE}${path}`, {}, { ...(await testEnv()), ...over }, ctx());
}

afterEach(() => vi.restoreAllMocks());

describe("closed until ready", () => {
  it("answers 503 teaching_not_open on /api/* and /auth/* while a secret is missing", async () => {
    for (const path of ["/api/session", "/auth/login?next=/teach", "/api/pr/1"]) {
      const res = await withEnv(path, { GITHUB_CLIENT_SECRET: "" });
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toEqual({ error: "teaching_not_open", message: NOT_OPEN });
    }
  });

  it("stays closed without the App's bot id in ludion.config.json", async () => {
    const res = await withEnv("/api/session", {}, null);
    expect(res.status).toBe(503);
  });

  it("logs which secret is missing by name, never a value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = await testEnv();
    await withEnv("/api/session", { SESSION_SECRET: "", GITHUB_APP_ID: "" });
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("Missing secrets: GITHUB_APP_ID, SESSION_SECRET.");
    expect(lines).not.toContain(env.GITHUB_CLIENT_SECRET);
  });

  it("refuses a SESSION_SECRET under 32 bytes, both at the gate and when signing", async () => {
    const short = btoa("x".repeat(31));
    expect(teachingProblem({ ...(await testEnv()), SESSION_SECRET: short }, BOT_ID)).toBe(SHORT_SESSION_SECRET);
    expect((await withEnv("/api/session", { SESSION_SECRET: short })).status).toBe(503);
    await expect(sign({ exp: 1 }, short)).rejects.toThrow(SHORT_SESSION_SECRET);
  });

  it("refuses a PKCS#1 private key with the conversion command", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    expect(teachingProblem({ ...(await testEnv()), GITHUB_APP_PRIVATE_KEY: pkcs1 }, BOT_ID)).toBe(PKCS1_KEY);
    expect(PKCS1_KEY).toContain("openssl pkcs8 -topk8 -nocrypt -in ludion.private-key.pem -out ludion.pk8.pem");
    await expect(appJwt({ appId: "1", installationId: "2", privateKey: pkcs1 }, 0)).rejects.toThrow(PKCS1_KEY);
  });

  it("is open with every secret set and a bot id", async () => {
    expect(teachingProblem(await testEnv(), BOT_ID)).toBeUndefined();
    expect((await withEnv("/api/session", {})).status).toBe(401);
  });
});

describe("account age", () => {
  async function callbackWith(createdAt: unknown) {
    const login = await request(new FakeNet(), "/auth/login?next=/teach");
    const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const net = new FakeNet()
      .on("POST https://github.com/login/oauth/access_token", () => Response.json({ access_token: "t" }))
      .on("GET https://api.github.com/user", () => Response.json({ login: "Alice", id: 1, avatar_url: "a", ...(createdAt === undefined ? {} : { created_at: createdAt }) }));
    return request(net, `/auth/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
  }

  it.each([undefined, null, "", "not a date", 12])("refuses an account whose age can't be read (%j)", async (createdAt) => {
    const res = await callbackWith(createdAt);
    expect(res.headers.get("Location")).toBe("/teach?error=account_too_new");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("ludion_session=") && !c.startsWith("ludion_session=;"))).toBe(false);
  });

  it("still lets an old account in", async () => {
    expect((await callbackWith("2015-01-01T00:00:00Z")).headers.get("Location")).toBe("/teach");
  });
});

describe("daily limit", () => {
  it("counts the App's PRs with this teacher's trailer from the last 24 hours, open or closed, and nothing else", async () => {
    const user = newUser();
    // 19 count; the App's PR for someone else, a person's PR with the trailer, and a 25-hour-old one don't.
    expect(pullsList(19, user.id)).toHaveLength(22);
    const ok = await post(github(pep(new FakeNet()), 19, user.id), "/api/teach", draft, user);
    expect(ok.status).toBe(201);
    const full = await post(github(pep(new FakeNet()), 20, user.id), "/api/teach", draft, user);
    expect(full.status).toBe(429);
  });
});

describe("the log", () => {
  it("never holds draft text, not even a failed source's URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const url = "https://docs.example.com/private-path-123";
    await post(page(new FakeNet(), url, "<p>Nothing here.</p>"), "/api/check", { ...draft, evidence: [{ source: { url, quote: QUOTE } }] }, newUser());
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain('"source_check":"not_confirmed"');
    for (const text of [url, "docs.example.com", QUOTE, draft.claim]) expect(lines).not.toContain(text);
  });

  it("never holds the question asked through ludion_ask", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const question = "secret-question-7f3a about distutils";
    await request(new FakeNet(), "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ludion_ask", arguments: { question } } }),
    });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("secret-question-7f3a");
  });
});
