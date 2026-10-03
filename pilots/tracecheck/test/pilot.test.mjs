// The tracecheck.dev pilot in Node, with D1 on node:sqlite and the site and agents stubbed.
// What must hold: the site's response is the response, untouched, for everyone; a fault in the
// pilot never reaches a visitor; humans are never recorded; automation is recorded with nothing a
// person sent; the morning report is @ludion/report's, over exactly yesterday (in Tokyo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPilot, observeOnly } from "../src/worker.mjs";
import { eventRow, agentHost, signatureFacts, COLUMNS } from "../src/observe.mjs";
import { store } from "../src/store.mjs";
import { daily, extras, notify } from "../src/daily.mjs";
import { buildReport, renderHtml } from "@ludion/report";
import { keypair, signed } from "../../../packages/gate-core/test/support.mjs";
import { d1, world, context, ENV, quietLog } from "./support.mjs";

const SITE = "https://tracecheck.dev";
const AGENT = "https://agent.example";
const DIRECTORY = `${AGENT}/.well-known/http-message-signatures-directory`;
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SECRET = "taro.yamada@example.jp";

/** The site behind the pilot: answers with a body and headers the test can recognise. */
const site = () => async (req) => new Response(`<html>${new URL(req.url).pathname}</html>`, {
  status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-site": "tracecheck", "set-cookie": "s=1; Path=/" },
});

const toRequest = (desc) => new Request(desc.targetUri, {
  method: desc.method, headers: desc.fields.map((f) => [f.name, f.value]), ...(desc.body != null ? { body: desc.body } : {}),
});

async function serve(pilot, request, env) {
  const ctx = context();
  const response = await pilot.fetch(request, env, ctx);
  await ctx.settle();
  return { response, ctx };
}

test("a person's request reaches the site as it came and gets the site's own response; nothing is recorded", async () => {
  let answered;
  const db = d1(), w = world({ origin: async (req) => (answered = await site()(req)) });
  try {
    const pilot = createPilot({ log: quietLog() });
    const request = new Request(`${SITE}/compare?who=${SECRET}`, { headers: { "user-agent": CHROME, cookie: "s=1" } });
    const { response, ctx } = await serve(pilot, request, ENV(db));
    assert.equal(ctx.passedThrough, true, "passThroughOnException is set before anything else can fail");
    assert.equal(w.calls.origin.length, 1);
    assert.equal(w.calls.origin[0], request, "the very Request goes on to the site");
    assert.equal(response, answered, "the very Response comes back");
    assert.equal(response.headers.get("x-site"), "tracecheck");
    assert.equal(response.headers.get("set-cookie"), "s=1; Path=/");
    assert.deepEqual([...response.headers.keys()].filter((k) => k.startsWith("ludion")), [], "no Ludion header is added");
    assert.equal(await response.text(), "<html>/compare</html>");
    await store(db).ensure();
    assert.deepEqual(db.rows(), [], "a person is never recorded");
  } finally { w.restore(); }
});

test("automation is recorded with route templates and fixed words only: no query, no address, no free text", async () => {
  const db = d1(), w = world({ origin: site() });
  try {
    const pilot = createPilot({ log: quietLog() });
    const env = ENV(db);
    await serve(pilot, new Request(`${SITE}/compare/claude-code?ref=${SECRET}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "cf-connecting-ip": "203.0.113.7" } }), env);
    await serve(pilot, new Request(`${SITE}/u/${SECRET}/settings`, { method: "POST", headers: { "user-agent": "python-requests/2.32", "cf-connecting-ip": "203.0.113.8", "content-type": "text/plain" }, body: SECRET }), env);
    await serve(pilot, new Request(`${SITE}/`, { headers: { "user-agent": CHROME } }), env);
    const rows = db.rows();
    assert.equal(rows.length, 2, "two automated requests, the person not");
    const [declared, suspected] = rows;
    assert.equal(declared.class, "DECLARED");
    assert.equal(declared.operator, "OpenAI");
    assert.equal(declared.token, "GPTBot");
    assert.equal(declared.decision, "allow");
    assert.equal(declared.pressure, 0);
    assert.equal(declared.site, "tracecheck.dev");
    assert.equal(declared.method, "GET");
    assert.equal(suspected.class, "SUSPECTED");
    assert.equal(suspected.token, "python-requests");
    assert.equal(suspected.method, "POST");
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), [...COLUMNS].sort());
      const all = JSON.stringify(r);
      for (const leak of [SECRET, "taro", "203.0.113", "ref=", "python-requests/2.32", "openai.com/gptbot"]) assert.ok(!all.includes(leak), `${leak} must not be recorded: ${all}`);
    }
    assert.match(suspected.route, /^\/u\/:[a-z]+\/settings$/);
  } finally { w.restore(); }
});

test("signed agents: VERIFIED with the directory's host; each signature's lifetime and nonce are kept (GATE-8)", async () => {
  const key = await keypair();
  const db = d1(), w = world({ origin: site(), directories: { [DIRECTORY]: { keys: [{ ...key.publicJwk, use: "sig" }] } } });
  try {
    const pilot = createPilot({ log: quietLog() });
    const env = ENV(db);
    const now = Math.floor(Date.now() / 1000);
    const minute = await signed({ key, url: `${SITE}/compare/cursor`, agent: AGENT, created: now - 1 });
    const hour = await signed({ key, url: `${SITE}/compare/cursor`, agent: AGENT, created: now - 1, lifetime: 3600 });
    const bare = await signed({ key, url: `${SITE}/compare/cursor`, agent: AGENT, created: now - 1, lifetime: 3600, nonce: null });
    for (const desc of [minute, hour, bare]) {
      const { response } = await serve(pilot, toRequest(desc), env);
      assert.equal(await response.text(), "<html>/compare/cursor</html>", "whatever the class, the site's own answer");
    }
    const [m, h, b] = db.rows();
    assert.equal(m.class, "VERIFIED");
    assert.equal(m.diver, DIRECTORY, "the resolved identifier (draft §4.1)");
    assert.equal(m.sig_agent, "agent.example");
    assert.deepEqual([m.sig_lifetime, m.sig_nonce], [60, 1]);
    assert.equal(h.class, "VERIFIED", "an hour with a nonce (GATE-8, plan A)");
    assert.deepEqual([h.sig_lifetime, h.sig_nonce], [3600, 1]);
    assert.equal(b.class, "SPOOFED", "past 60 s without a nonce (spec §10.4)");
    assert.equal(b.reason, "invalid_signature");
    assert.deepEqual([b.sig_lifetime, b.sig_nonce, b.sig_agent], [3600, 0, "agent.example"]);
  } finally { w.restore(); }
});

test("a signed body: the site still gets every byte, and the Gate checks the copy", async () => {
  const key = await keypair();
  let got = null;
  const db = d1(), w = world({
    origin: async (req) => { got = await req.text(); return new Response("ok"); },
    directories: { [DIRECTORY]: { keys: [{ ...key.publicJwk, use: "sig" }] } },
  });
  try {
    const pilot = createPilot({ log: quietLog() });
    const body = JSON.stringify({ q: "x".repeat(70_000) });
    const desc = await signed({ key, method: "POST", url: `${SITE}/api/search`, body, agent: AGENT, created: Math.floor(Date.now() / 1000) - 1 });
    const { response } = await serve(pilot, toRequest(desc), ENV(db));
    assert.equal(await response.text(), "ok");
    assert.equal(got, body, "the site received the whole body");
    const [row] = db.rows();
    assert.equal(row.class, "VERIFIED", "the Gate read the copy and the digest matched");
  } finally { w.restore(); }
});

test("faults stay in the pilot: a dead D1, a refused config, a throwing Gate never touch the response", async () => {
  const w = world({ origin: site() });
  try {
    // D1 fails on every call.
    const log1 = quietLog(), dead = d1({ fail: true }), pilot1 = createPilot({ log: log1 });
    for (let i = 0; i < 3; i++) {
      const { response } = await serve(pilot1, new Request(`${SITE}/`, { headers: { "user-agent": "GPTBot/1.2" } }), ENV(dead));
      assert.equal(await response.text(), "<html>/</html>");
    }
    assert.equal(log1.lines.filter((l) => l.includes("d1 insert")).length, 1, "said once, not once per request");

    // A config the pilot refuses: the Gate is off, the site is not.
    for (const LUDION of [{ site_id: "tracecheck.dev", pressure: 1 }, { site_id: "tracecheck.dev", routes: [{ match: "/api/**", pressure: 2 }] },
      { site_id: "tracecheck.dev", report: { endpoint: "https://collector.example/e" } }, "{not json", { site_id: "tracecheck.dev", presure: 0 }]) {
      const log = quietLog(), db = d1(), pilot = createPilot({ log });
      const { response } = await serve(pilot, new Request(`${SITE}/x`, { headers: { "user-agent": "GPTBot/1.2" } }), ENV(db, { LUDION }));
      assert.equal(await response.text(), "<html>/x</html>");
      assert.ok(log.lines.some((l) => l.includes("gate disabled")), `refused: ${JSON.stringify(LUDION)} → ${log.lines}`);
      assert.equal(w.calls.other.length, 0, "a refused report endpoint is never called");
    }

    // A request whose headers cannot even be read.
    const log3 = quietLog(), pilot3 = createPilot({ log: log3 });
    const weird = new Request(`${SITE}/y`);
    Object.defineProperty(weird, "headers", { get() { throw new Error("planted"); } });
    const ctx = context();
    const response = await pilot3.fetch(weird, ENV(d1()), ctx);
    await ctx.settle();
    assert.equal(await response.text(), "<html>/y</html>");
    assert.ok(log3.lines.some((l) => l.includes("planted")));
  } finally { w.restore(); }
});

test("observeOnly: Pressure 0 and no endpoint, or nothing", () => {
  assert.deepEqual(observeOnly({ site_id: "tracecheck.dev", pressure: 0 }), { site_id: "tracecheck.dev", pressure: 0 });
  assert.equal(observeOnly('{"site_id":"tracecheck.dev"}').site_id, "tracecheck.dev");
  assert.ok(observeOnly({ site_id: "a", routes: [{ match: "/x/**" }, { match: "/y", pressure: 0 }] }));
  for (const bad of [{ site_id: "a", pressure: 2 }, { site_id: "a", pressure: "0" }, { site_id: "a", routes: [{ match: "/c/**", pressure: 3 }] },
    { site_id: "a", report: { send_metadata: false } }, null, [], "[]", "x"]) {
    assert.throws(() => observeOnly(bad), TypeError, JSON.stringify(bad));
  }
});

test("observe helpers: the agent's host, never an address or a path; signature facts", () => {
  assert.equal(agentHost('"https://chatgpt.com"'), "chatgpt.com");
  assert.equal(agentHost('sig1="https://agent.example/some/path?x=1"'), "agent.example");
  for (const bad of ['"https://203.0.113.9"', '"https://[2001:db8::1]"', '"https://localhost"', "none", undefined, '"ftp://a.example"']) assert.equal(agentHost(bad), null, String(bad));
  assert.deepEqual(signatureFacts('sig1=("@authority");created=1754300000;expires=1754303600;keyid="k";nonce="n";tag="web-bot-auth"'), { lifetime: 3600, nonce: 1 });
  assert.deepEqual(signatureFacts('sig1=("@authority");created=1754300000;keyid="k"'), { lifetime: null, nonce: 0 });
  assert.deepEqual(signatureFacts(undefined), { lifetime: null, nonce: null });
  assert.equal(eventRow({ cls: { class: "UNKNOWN" }, receipt: { rid: "r" } }, new Request(`${SITE}/`)), null);
  assert.equal(eventRow({ cls: { class: "DECLARED" }, receipt: null }, new Request(`${SITE}/`)), null);
});

// ── the morning report ─────────────────────────────────────────────────────────────────────
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const row = (over) => ({
  rid: `rcp-${Math.random().toString(36).slice(2)}`, ts: at("2026-10-04T12:00:00+09:00"), site: "tracecheck.dev", method: "GET", route: "/compare/:param",
  class: "DECLARED", decision: "allow", error: null, pressure: 0, diver: null, country: "US", operator: "OpenAI", token: "GPTBot",
  reason: null, code: null, sig_agent: null, sig_lifetime: null, sig_nonce: null, ...over,
});

test("the morning report is @ludion/report over exactly yesterday in Tokyo, saved in both languages and posted", async () => {
  const db = d1(), st = store(db);
  const rows = [
    row({ ts: at("2026-10-04T00:00:00+09:00") }), // first second of the day: in
    row({ ts: at("2026-10-04T23:59:59+09:00"), class: "SUSPECTED", operator: null, token: "curl/" }), // last second: in
    row({ ts: at("2026-10-05T00:00:00+09:00") }), // today: out
    row({ ts: at("2026-10-03T23:59:59+09:00"), operator: "Google", token: "Googlebot" }), // the day before: the comparison only
    row({ class: "VERIFIED", diver: "https://chatgpt.com", operator: null, token: null, sig_agent: "chatgpt.com", sig_lifetime: 60, sig_nonce: 1 }),
    row({ class: "SPOOFED", operator: null, token: null, reason: "invalid_signature", sig_agent: "chatgpt.com", sig_lifetime: 3600, sig_nonce: 1 }),
    row({ method: "POST", route: "/login", class: "SUSPECTED", operator: null, token: "python-requests" }),
    row({ site: "other.example" }), // another site: never in this report
  ];
  for (const r of rows) await st.insert(r);
  await st.insert(row({ ts: at("2026-06-01T00:00:00+09:00") })); // past retention

  const posts = [];
  const fakeFetch = async (url, init) => { posts.push({ url, init }); return new Response("", { status: 200 }); };
  const now = Date.parse("2026-10-04T22:00:00Z"); // the cron: 07:00 on the 5th in Tokyo
  const r = await daily({ db, site: "tracecheck.dev", tz: "Asia/Tokyo", now, webhook: "https://discord.com/api/webhooks/1/x", retainDays: 90, fetch: fakeFetch });
  assert.equal(r.date, "2026-10-04");
  assert.deepEqual(r.problems, []);

  // The same numbers @ludion/report computes from the same events as NDJSON.
  const ndjson = rows.map((x) => JSON.stringify(x)).join("\n");
  const expected = buildReport(ndjson, { date: "2026-10-04", tz: "Asia/Tokyo", site: "tracecheck.dev" });
  assert.deepEqual(r.summary, expected);
  assert.equal(r.summary.events, 5);
  assert.equal(r.summary.previous.events, 1);
  assert.equal(r.summary.critical.unverified, 1, "the POST /login");

  const saved = db.rows("SELECT * FROM reports ORDER BY lang");
  assert.deepEqual(saved.map((s) => s.lang), ["en", "ja"]);
  assert.equal(saved[1].html, renderHtml(expected, "ja"));
  assert.equal(JSON.parse(saved[0].summary).pilot.long_lived, 1);

  assert.deepEqual(r.extras.declared, [{ key: "OpenAI", count: 1 }]);
  assert.deepEqual(r.extras.signers, [{ key: "chatgpt.com", count: 2 }]);
  assert.deepEqual(r.extras.unverified, [{ key: "SPOOFED invalid_signature", count: 1 }]);

  assert.equal(posts.length, 1);
  const form = posts[0].init.body;
  assert.ok(form instanceof FormData);
  const payload = JSON.parse(form.get("payload_json"));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content, /^\[Ludion\] tracecheck\.dev 2026-10-04/);
  assert.match(payload.content, /寿命が 60 秒を超えるもの 1 件/);
  const file = form.get("files[0]");
  assert.equal(file.name, "ludion-tracecheck.dev-2026-10-04.html");
  assert.equal(await file.text(), renderHtml(expected, "ja"));

  assert.equal(db.rows("SELECT * FROM events WHERE ts < " + at("2026-07-01T00:00:00Z")).length, 0, "pruned past retention");
  assert.equal(db.rows().length, rows.length, "nothing else pruned");
});

test("the report is saved even when the webhook fails, and the failure is reported, not swallowed", async () => {
  const db = d1();
  await store(db).insert(row({}));
  const r = await daily({ db, site: "tracecheck.dev", tz: "Asia/Tokyo", now: Date.parse("2026-10-04T22:00:00Z"), webhook: "https://discord.com/api/webhooks/1/x",
    fetch: async () => new Response("no", { status: 404 }) });
  assert.match(r.problems.join(), /answered 404/);
  assert.equal(db.rows("SELECT * FROM reports").length, 2);

  const pilot = createPilot({ log: quietLog() });
  const w = world({ origin: site(), others: async () => new Response("no", { status: 500 }) });
  try {
    await assert.rejects(pilot.scheduled({ scheduledTime: Date.parse("2026-10-04T22:00:00Z") }, ENV(db, { REPORT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" })), /saved, but: report webhook answered 500/);
  } finally { w.restore(); }
});

test("an empty day is still a report; Slack gets text without markup", async () => {
  const db = d1();
  const posts = [];
  const r = await daily({ db, site: "tracecheck.dev", tz: "Asia/Tokyo", now: Date.parse("2026-10-04T22:00:00Z"), webhook: "https://hooks.slack.com/services/T/B/x",
    fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return new Response("ok"); } });
  assert.equal(r.summary.events, 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].unfurl_links, false);
  assert.ok(!/[<>]/.test(posts[0].text));
  assert.deepEqual(extras([]), { declared: [], suspected: [], signers: [], unverified: [], long_lived: 0 });
  await assert.rejects(notify("https://discord.com/api/webhooks/1/x", { content: "x", html: "", filename: "a.html" }, { fetch: async () => new Response("", { status: 400 }) }), /400/);
});

test("the store pages through a long day without losing or repeating a row", async () => {
  const db = d1(), st = store(db);
  const ts = at("2026-10-04T10:00:00+09:00");
  for (let i = 0; i < 12_345; i++) await st.insert(row({ rid: `r${i}`, ts: ts + (i % 7) }));
  const got = await st.events(ts, ts + 7);
  assert.equal(got.length, 12_345);
  assert.equal(new Set(got.map((g) => g.rid)).size, 12_345);
  assert.equal((await st.events(ts + 3, ts + 4)).length, Math.ceil((12_345 - 3) / 7));
});

test("the span summary: the daily report's counting over the week, each day's totals adding up to it, rows from wrangler's --json", async () => {
  const { summarizeSpan, rowsOf, renderSummary } = await import("../summary.mjs");
  const rows = [
    row({ ts: at("2026-10-03T23:59:59+09:00") }), // the day before: out
    row({ ts: at("2026-10-04T00:00:00+09:00") }),
    row({ ts: at("2026-10-05T12:00:00+09:00"), class: "VERIFIED", diver: "https://chatgpt.com", operator: null, token: null, sig_agent: "chatgpt.com", sig_lifetime: 3600, sig_nonce: 1 }),
    row({ ts: at("2026-10-06T08:00:00+09:00"), method: "POST", route: "/login", class: "SUSPECTED", operator: null, token: "curl/" }),
    row({ ts: at("2026-10-06T23:59:59+09:00"), site: "other.example" }), // another site: out
    row({ ts: at("2026-10-07T00:00:00+09:00") }), // after the span: out
  ];
  const wrangler = JSON.stringify([{ results: rows, success: true, meta: {} }]);
  assert.deepEqual(rowsOf(wrangler), rows);
  assert.throws(() => rowsOf('{"x":1}'), TypeError);
  const s = summarizeSpan(rowsOf(wrangler), { from: "2026-10-04", to: "2026-10-06" });
  assert.equal(s.events, 3);
  assert.deepEqual(s.days.map((d) => d.events), [1, 1, 1]);
  assert.equal(s.days.reduce((n, d) => n + d.critical_unverified, 0), s.critical.unverified);
  assert.equal(s.critical.unverified, 1);
  assert.deepEqual(s.top_agents, [{ agent: "chatgpt.com", actions: 1 }]);
  assert.deepEqual(s.pilot.lifetimes, { 3600: 1 });
  const text = renderSummary(s);
  assert.match(text, /^tracecheck\.dev：2026-10-04〜2026-10-06/);
  assert.match(text, /検証済みのエージェント：chatgpt\.com 1/);
});
