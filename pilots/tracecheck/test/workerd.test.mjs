// PILOT-1 in workerd: the deployable Worker (real wrangler.jsonc, real bundle) in front of a stub
// site. People and agents get the site's bytes and headers, the site gets every request and body
// as sent, automation (only) lands in D1, and the morning run posts a report. Slow: not in npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startPilot, stubServer } from "./workerd.mjs";

const SECRET = "taro.yamada@example.jp";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const HOP = new Set(["date", "connection", "keep-alive", "transfer-encoding", "content-length"]);

test("PILOT-1 (workerd): the site's response, untouched; automation recorded; a report posted", { timeout: 240_000 }, async () => {
  const site = await stubServer((req, body) => ({
    status: req.url.startsWith("/missing") ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "set-cookie": ["a=1; Path=/", "b=2; Path=/; HttpOnly"], etag: '"abc"', "cache-control": "public, max-age=0, must-revalidate", "x-site": "tracecheck" },
    body: `<html>${req.method} ${req.url} ${body.length}</html>`,
  }));
  const hook = await stubServer(() => ({ status: 200, body: "ok" }));
  const pilot = await startPilot({ upstreamPort: site.port, vars: { REPORT_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/hook` } });
  try {
    const cases = [
      { name: "person", path: `/compare?who=${encodeURIComponent(SECRET)}`, headers: { "user-agent": CHROME, cookie: "s=1" } },
      { name: "person 404", path: "/missing/page", headers: { "user-agent": CHROME } },
      { name: "GPTBot", path: "/compare/claude-code", headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" } },
      { name: "script POST", path: `/api/u/${encodeURIComponent(SECRET)}`, method: "POST", headers: { "user-agent": "python-requests/2.32", "content-type": "text/plain" }, body: SECRET.repeat(5000) },
      { name: "no UA", path: "/feed.xml", headers: { "user-agent": "" } },
    ];
    for (const c of cases) {
      const before = site.seen.length;
      // identity: what compression the edge applies on the way out is the runtime's, not the Worker's.
      const res = await fetch(pilot.origin + c.path, { method: c.method ?? "GET", headers: { "accept-encoding": "identity", ...c.headers }, body: c.body, redirect: "manual" });
      const text = await res.text();
      assert.equal(site.seen.length - before, 1, `${c.name}: the site saw it once`);
      const got = site.seen.at(-1);
      assert.equal(got.method, c.method ?? "GET", c.name);
      assert.equal(got.url, c.path, `${c.name}: the path and query as sent`);
      assert.equal(got.body.toString(), c.body ?? "", `${c.name}: every byte of the body`);
      if (c.headers.cookie) assert.equal(got.headers.cookie, c.headers.cookie);
      assert.equal(text, `<html>${c.method ?? "GET"} ${c.path} ${(c.body ?? "").length}</html>`, `${c.name}: the site's body`);
      assert.equal(res.status, c.path.startsWith("/missing") ? 404 : 200, c.name);
      assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/; HttpOnly"], c.name);
      const names = [...new Set(res.headers.keys())].filter((k) => !HOP.has(k)).sort();
      assert.deepEqual(names, ["cache-control", "content-type", "etag", "set-cookie", "x-site"], `${c.name}: no header added or lost`);
    }

    const run = await fetch(`${pilot.origin}/__scheduled?cron=${encodeURIComponent("0 22 * * *")}`);
    assert.equal(run.status, 200, await run.text());
    for (let i = 0; i < 50 && !hook.seen.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(hook.seen.length, 1, `the report was posted\n${pilot.log.slice(-1500)}`);
    const post = hook.seen[0];
    assert.match(post.headers["content-type"], /^multipart\/form-data/);
    const body = post.body.toString("utf8");
    assert.match(body, /\[Ludion\] tracecheck\.dev \d{4}-\d{2}-\d{2}/);
    assert.match(body, /filename="ludion-tracecheck\.dev-\d{4}-\d{2}-\d{2}\.html"/);
    assert.match(body, /<!doctype html>/);
  } finally {
    await pilot.stop();
    await site.close(); await hook.close();
  }
  try {
    const rows = pilot.d1("SELECT class, method, route, operator, token, site, pressure, decision FROM events ORDER BY rowid");
    assert.deepEqual(rows.map((r) => [r.class, r.method, r.operator, r.token]), [
      ["DECLARED", "GET", "OpenAI", "GPTBot"], ["SUSPECTED", "POST", null, "python-requests"], ["SUSPECTED", "GET", null, "missing-user-agent"],
    ], "automation only, people never");
    for (const r of rows) {
      assert.equal(r.site, "tracecheck.dev"); assert.equal(r.pressure, 0); assert.equal(r.decision, "allow");
      assert.ok(!JSON.stringify(r).includes("taro"), JSON.stringify(r));
    }
    const reports = pilot.d1("SELECT lang, site FROM reports ORDER BY lang");
    assert.deepEqual(reports.map((r) => r.lang), ["en", "ja"]);
  } finally { pilot.cleanup(); }
});
