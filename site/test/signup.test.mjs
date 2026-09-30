// The early-access endpoint (site/edge/signup.mjs) on Node's Fetch API, with a notifier stub and
// a fake clock. WEB-8 runs the same code in workerd behind the real form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, handleSignup, HONEYPOT, LIMITS, MAX_BODY } from "../edge/signup.mjs";
import worker from "../edge/worker.mjs";

const HOOK = "https://hooks.example/notify";
const PERSON = { email: "Ana@Shop.example", role: "site", site: "https://shop.example", lang: "ja" };

function notifier({ status = 200, fail = false } = {}) {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) throw new TypeError("fetch failed");
    return new Response("ok", { status });
  };
  return { calls, send };
}
function clock(t = Date.parse("2026-10-01T03:00:00Z")) {
  const c = () => t;
  c.advance = (ms) => { t += ms; };
  return c;
}
const post = (body, { type = "application/json", headers = {} } = {}) => new Request("https://ludion.ai/api/signup", {
  method: "POST", headers: { "content-type": type, ...headers },
  body: typeof body === "string" ? body : type === "application/json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
});
/** One endpoint with its own limiter, notifier and clock. */
function endpoint({ limits = LIMITS, webhook = HOOK, ...n } = {}) {
  const now = clock();
  const { calls, send } = notifier(n);
  const limiter = createLimiter(limits, now);
  const call = (req, client = "198.51.100.7") => handleSignup(req, { webhook, client, limiter, fetch: send, now });
  return { call, calls, now };
}
const answer = async (res) => ({ status: res.status, body: await res.json() });

test("signup: a person's submission reaches the notifier, and only then is answered ok", async () => {
  for (const type of ["application/json", "application/x-www-form-urlencoded"]) {
    const e = endpoint();
    assert.deepEqual(await answer(await e.call(post(PERSON, { type }))), { status: 200, body: { ok: true } }, type);
    assert.equal(e.calls.length, 1);
    const { url, init, body } = e.calls[0];
    assert.equal(url, HOOK);
    assert.equal(init.method, "POST");
    assert.ok(init.signal instanceof AbortSignal, "the notifier has a deadline");
    assert.deepEqual(body.record, { ts: "2026-10-01T03:00:00.000Z", email: "ana@shop.example", role: "site", site: "https://shop.example", lang: "ja" });
    assert.equal(body.text, "New Ludion signup: ana@shop.example (site, https://shop.example, ja)");
    assert.equal(body.content, body.text, "Discord reads content");
    assert.deepEqual(body.allowed_mentions, { parse: [] }, "Discord pings no one");
  }
});

test("signup: a filled honeypot is answered exactly like a success and never reaches the notifier", async () => {
  const e = endpoint();
  const ok = await e.call(post(PERSON));
  const okBody = await ok.text();
  for (const type of ["application/json", "application/x-www-form-urlencoded"]) {
    const bot = await e.call(post({ ...PERSON, [HONEYPOT]: "Great site! Visit https://spam.example" }, { type }), `203.0.113.${type.length}`);
    assert.equal(bot.status, ok.status);
    assert.equal(await bot.text(), okBody);
    assert.deepEqual([...bot.headers], [...ok.headers]);
  }
  assert.equal(e.calls.length, 1, "only the person");
});

test("signup: one client past its limit is answered 429 with Retry-After and dropped; others still pass", async () => {
  const e = endpoint();
  const results = [];
  for (let i = 0; i < LIMITS.perClient + 3; i++) results.push((await e.call(post({ ...PERSON, email: `p${i}@shop.example` }), "203.0.113.1")).status);
  assert.deepEqual(results, [...Array(LIMITS.perClient).fill(200), 429, 429, 429]);
  assert.equal(e.calls.length, LIMITS.perClient);
  const held = await e.call(post(PERSON), "203.0.113.1");
  assert.equal(held.status, 429);
  assert.deepEqual(await held.json(), { error: "rate_limited" });
  const wait = Number(held.headers.get("retry-after"));
  assert.ok(wait >= 1 && wait <= LIMITS.windowMs / 1000, `retry-after ${wait}`);
  assert.equal((await e.call(post(PERSON), "203.0.113.2")).status, 200, "another client");
  // Every POST counts, garbage too: a client flooding junk is held as well.
  for (let i = 0; i < LIMITS.perClient; i++) await e.call(post("{", { type: "application/json" }), "203.0.113.3");
  assert.equal((await e.call(post(PERSON), "203.0.113.3")).status, 429);
  // A client that keeps sending faster than its limit stays held, window after window; once it
  // stops for a window, it passes again.
  const step = Math.floor(LIMITS.windowMs / LIMITS.perClient) - 1;
  const later = [];
  for (let i = 0; i < LIMITS.perClient * 6; i++) { e.now.advance(step); later.push((await e.call(post(PERSON), "203.0.113.1")).status); }
  assert.deepEqual([...new Set(later)], [429]);
  e.now.advance(LIMITS.windowMs);
  assert.equal((await e.call(post(PERSON), "203.0.113.1")).status, 200);
});

test("signup: the global limit holds a crowd, and one client held at its own limit never fills it", async () => {
  const limits = { perClient: 2, global: 10, windowMs: 60_000, clients: 1000 };
  const e = endpoint({ limits });
  for (let i = 0; i < 500; i++) await e.call(post(PERSON), "203.0.113.66");
  assert.equal(e.calls.length, 2);
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push((await e.call(post(PERSON), `198.51.100.${i}`)).status);
  assert.deepEqual(crowd, [...Array(8).fill(200), 429, 429, 429, 429]);
  assert.equal(e.calls.length, 10);
  e.now.advance(60_000);
  assert.equal((await e.call(post(PERSON), "198.51.100.200")).status, 200);
});

test("signup: at most `clients` clients are remembered; the longest idle is forgotten first", () => {
  const now = clock();
  const l = createLimiter({ perClient: 1, global: 1e9, windowMs: 60_000, clients: 2 }, now);
  assert.equal(l.take("a"), 0);
  assert.equal(l.take("b"), 0);
  assert.ok(l.take("a") > 0, "a is held (and now the most recent)");
  assert.equal(l.take("c"), 0, "c pushes out b, the longest idle");
  assert.equal(l.take("b"), 0, "b was forgotten");
  assert.ok(l.take("b") > 0);
});

test("signup: what is not a submission is refused, and none of it reaches the notifier", async () => {
  const e = endpoint({ limits: { ...LIMITS, perClient: 1e9, global: 1e9 } });
  const cases = [
    [new Request("https://ludion.ai/api/signup"), 405, { error: "method" }],
    [post({ ...PERSON, email: "not an email" }), 400, { error: "email" }],
    [post({ ...PERSON, email: "<!channel>@shop.example" }), 400, { error: "email" }],
    [post({ ...PERSON, email: `${"a".repeat(250)}@x.example` }), 400, { error: "email" }],
    [post({ ...PERSON, email: undefined }), 400, { error: "email" }],
    [post("[1,2]"), 400, { error: "email" }],
    [post("not json"), 400, { error: "email" }],
    [post("email=a@b.example", { type: "text/plain" }), 415, { error: "content_type" }],
    [post({ ...PERSON, pad: "x".repeat(MAX_BODY) }), 413, { error: "too_large" }],
    [post(PERSON, { headers: { "content-length": String(MAX_BODY + 1) } }), 413, { error: "too_large" }],
  ];
  for (const [req, status, body] of cases) assert.deepEqual(await answer(await e.call(req)), { status, body }, `${req.method} ${status}`);
  assert.equal(e.calls.length, 0);
  assert.equal((await e.call(new Request("https://ludion.ai/api/signup"))).headers.get("allow"), "POST");
});

test("signup: fields are cut to what the notifier may show", async () => {
  const e = endpoint();
  await e.call(post({ email: "a&b@shop.example", role: "insurer", site: "https://x.example/<b>", lang: "fr", extra: "dropped" }));
  const { record, text } = e.calls[0].body;
  assert.deepEqual(record, { ts: record.ts, email: "a&b@shop.example", role: "other", site: "", lang: "en" });
  assert.equal(text, "New Ludion signup: a&amp;b@shop.example (other, en)", "Slack reads &, < and > as markup");
});

test("signup: when the notifier is missing, fails or throws, the answer says it was not sent", async () => {
  for (const [opts, status, body] of [
    [{ webhook: "" }, 503, { error: "unavailable" }],
    [{ status: 500 }, 502, { error: "notify" }],
    [{ status: 404 }, 502, { error: "notify" }],
    [{ fail: true }, 502, { error: "notify" }],
  ]) {
    const e = endpoint(opts);
    assert.deepEqual(await answer(await e.call(post(PERSON))), { status, body }, JSON.stringify(opts));
  }
});

test("signup: nothing is logged (the email lives only in the notification)", async () => {
  const said = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) { saved[k] = console[k]; console[k] = (...a) => said.push(a); }
  try {
    for (const opts of [{}, { fail: true }, { status: 500 }, { webhook: "" }]) {
      const e = endpoint(opts);
      await e.call(post(PERSON));
      await e.call(post({ ...PERSON, [HONEYPOT]: "x" }));
      await e.call(post({ email: "bad" }));
    }
  } finally { Object.assign(console, saved); }
  assert.deepEqual(said, []);
});

test("signup: the Worker sends /api/signup to the endpoint, keyed by CF-Connecting-IP, and the rest to the static files", async () => {
  const seen = [];
  const env = { SIGNUP_WEBHOOK_URL: HOOK, ASSETS: { fetch: async (r) => { seen.push(new URL(r.url).pathname); return new Response("page"); } } };
  const saved = globalThis.fetch;
  const { calls, send } = notifier();
  globalThis.fetch = send;
  try {
    assert.equal(await (await worker.fetch(new Request("https://ludion.ai/ja"), env)).text(), "page");
    const statuses = [];
    for (let i = 0; i < LIMITS.perClient + 1; i++) {
      statuses.push((await worker.fetch(post(PERSON, { headers: { "cf-connecting-ip": "192.0.2.10" } }), env)).status);
    }
    assert.deepEqual(statuses, [...Array(LIMITS.perClient).fill(200), 429]);
    assert.equal((await worker.fetch(post(PERSON, { headers: { "cf-connecting-ip": "192.0.2.11" } }), env)).status, 200);
    assert.equal(calls.length, LIMITS.perClient + 1);
  } finally { globalThis.fetch = saved; }
  assert.deepEqual(seen, ["/ja"]);
});

test("signup: the Vercel function is the same endpoint, keyed by X-Real-IP", async () => {
  const { POST } = await import("../api/signup.js");
  const saved = { fetch: globalThis.fetch, hook: process.env.SIGNUP_WEBHOOK_URL };
  const { calls, send } = notifier();
  globalThis.fetch = send;
  process.env.SIGNUP_WEBHOOK_URL = HOOK;
  try {
    const statuses = [];
    for (let i = 0; i < LIMITS.perClient + 1; i++) statuses.push((await POST(post(PERSON, { headers: { "x-real-ip": "192.0.2.20" } }))).status);
    assert.deepEqual(statuses, [...Array(LIMITS.perClient).fill(200), 429]);
    assert.equal((await POST(post({ ...PERSON, [HONEYPOT]: "x" }, { headers: { "x-real-ip": "192.0.2.21" } }))).status, 200);
    assert.equal(calls.length, LIMITS.perClient);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.hook === undefined) delete process.env.SIGNUP_WEBHOOK_URL; else process.env.SIGNUP_WEBHOOK_URL = saved.hook;
  }
});
