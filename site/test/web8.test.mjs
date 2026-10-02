// WEB-8 (±): the early-access form. A person's submission reaches the notifier; a bot's does not.
// - Where: the site as it deploys to Workers (site/edge: the built static files and the Worker with
//   POST /api/signup), run by wrangler dev in workerd, the notifier a local webhook stub
//   (./edge.mjs). The preview cannot be deployed yet (WEB-1); this is the artifact it will run.
// - A person (+): on / and /ja, in headless Chromium, the form is filled and sent. The page makes
//   one request for it, a POST to the site's own endpoint; the notifier gets exactly that person,
//   and only then does the page say it was received.
// - Bots (−): a bot that fills every field fills the honeypot. In the browser and posted directly
//   (JSON and form-encoded) it is answered like a person and never reaches the notifier. One client
//   posting a burst gets through its limit, then 429 with Retry-After, and the page says so; the
//   rest never reach the notifier, and another client still gets through.
// - The check bites: an endpoint that ignores the honeypot, has no limit, keys the limit on nothing,
//   or answers ok without notifying is each caught by the rule meant for it.
// Clients are told apart by CF-Connecting-IP, which Cloudflare sets and wrangler dev passes on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSite } from "../build.mjs";
import { launchChromium } from "./browser.mjs";
import { EDGE, startEdge, startNotifier } from "./edge.mjs";
import { ENDPOINT, HONEYPOT, LIMITS } from "../edge/signup.mjs";
import { STRINGS } from "../src/signup/strings.mjs";

let dist, hook, edge, browser;
before(async () => {
  dist = buildSite();
  hook = await startNotifier();
  edge = await startEdge({ dist, vars: { SIGNUP_WEBHOOK_URL: hook.url } });
  browser = await launchChromium();
});
after(async () => {
  await browser?.close();
  await edge?.stop();
  await hook?.close();
});

let n = 0;
const email = (who) => `${who}-${process.pid}-${++n}@shop.example`;
const notified = (h, address) => h.received.filter((r) => r.body?.record?.email === address);
const direct = (origin, ip, body, type = "application/json") => fetch(origin + ENDPOINT, {
  method: "POST", headers: { "content-type": type, "cf-connecting-ip": ip },
  body: type === "application/json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
});
const settled = (page) => page.waitForFunction(() => {
  const s = document.querySelector("form.ludion-signup")?.dataset.state;
  return s && !["loading", "idle", "sending"].includes(s) ? s : null;
}, null, { timeout: 30_000 }).then((h) => h.jsonValue());

/** Open a page with the form as client `ip`; every request the browser makes is kept. */
async function open(urlPath, ip) {
  const context = await browser.newContext({ extraHTTPHeaders: { "cf-connecting-ip": ip } });
  const requests = [], errors = [];
  context.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" }));
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(edge.origin + urlPath, { waitUntil: "load" });
  await page.waitForSelector('form.ludion-signup[data-state="idle"]', { state: "attached" });
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  return { context, page, requests, errors };
}

/**
 * What a deployment does with a person, a honeypot bot and a burst, over plain HTTP. Each client
 * has its own address, so one run never limits another.
 * @returns {Promise<{ findings: { rule: string, what: string }[], burst: number[] }>}
 */
async function exercise(origin, h, tag) {
  const findings = [];
  const find = (rule, what) => findings.push({ rule, what });
  const ip = (i) => `198.51.100.${(tag * 10 + i) % 250}`;

  const person = email("person");
  const r = await direct(origin, ip(1), { email: person, role: "site", site: "https://shop.example", lang: "en" });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || body?.ok !== true) find("person", `a person was answered ${r.status} ${JSON.stringify(body)}`);
  if (notified(h, person).length !== 1) find("notifier", `a person answered ${r.status} reached the notifier ${notified(h, person).length} times`);

  for (const type of ["application/json", "application/x-www-form-urlencoded"]) {
    const bot = email("bot");
    const b = await direct(origin, ip(2), { email: bot, role: "site", lang: "en", [HONEYPOT]: "Great post! https://spam.example" }, type);
    const said = await b.text();
    if (b.status !== 200 || said !== JSON.stringify({ ok: true })) find("honeypot answer", `a honeypot bot (${type}) was answered ${b.status} ${said}: not like a person`);
    if (notified(h, bot).length) find("honeypot", `a honeypot bot (${type}) reached the notifier`);
  }

  const burst = [], sent = [];
  for (let i = 0; i < LIMITS.perClient + 5; i++) {
    const a = email("burst");
    sent.push(a);
    const res = await direct(origin, ip(3), { email: a, role: "agent", lang: "en" });
    burst.push(res.status);
    if (res.status === 429 && !(Number(res.headers.get("retry-after")) >= 1)) find("rate limit", `429 without Retry-After`);
  }
  const want = [...Array(LIMITS.perClient).fill(200), ...Array(5).fill(429)];
  if (JSON.stringify(burst) !== JSON.stringify(want)) find("rate limit", `a burst of ${burst.length} from one client was answered [${burst.join(", ")}]`);
  const through = sent.filter((a) => notified(h, a).length);
  if (JSON.stringify(through) !== JSON.stringify(sent.slice(0, LIMITS.perClient))) find("rate limit", `${through.length} of a burst of ${sent.length} reached the notifier`);

  const other = email("other");
  const o = await direct(origin, ip(4), { email: other, role: "site", lang: "ja" });
  if (o.status !== 200 || notified(h, other).length !== 1) find("rate limit (others)", `after one client's burst, another client was answered ${o.status}`);
  return { findings, burst };
}

// ── a person ────────────────────────────────────────────────────────────────────────────────
const people = [];
test("WEB-8: a person's submission on / and /ja reaches the notifier through the site's own endpoint, and the page says so", async () => {
  for (const [urlPath, lang, ip] of [["/", "en", "192.0.2.1"], ["/ja", "ja", "192.0.2.2"]]) {
    const { context, page, requests, errors } = await open(urlPath, ip);
    try {
      const address = email(`person-${lang}`);
      await page.fill('form.ludion-signup input[name="email"]', address);
      await page.selectOption('form.ludion-signup select[name="role"]', "agent");
      await page.fill('form.ludion-signup input[name="site"]', "https://agent.example");
      await page.click('form.ludion-signup button[type="submit"]');
      assert.equal(await settled(page), "done", `${urlPath}: the state after sending`);
      assert.equal(await page.textContent("form.ludion-signup .signup-status"), STRINGS[lang].states.done);
      assert.equal(await page.inputValue('form.ludion-signup input[name="email"]'), "", `${urlPath}: the form is cleared`);

      const got = notified(hook, address);
      assert.equal(got.length, 1, `${urlPath}: notifications for the person`);
      const { ts, ...record } = got[0].body.record;
      assert.deepEqual(record, { email: address, role: "agent", site: "https://agent.example", lang });
      assert.ok(Math.abs(Date.parse(ts) - Date.now()) < 60_000, "a fresh timestamp");
      assert.equal(got[0].method, "POST");
      assert.match(got[0].headers["content-type"], /^application\/json/);
      assert.ok(got[0].body.text.includes(address) && got[0].body.content === got[0].body.text, "Slack's text and Discord's content");
      assert.ok((got[0].body.flags & 4) === 4 && got[0].body.unfurl_links === false && got[0].body.unfurl_media === false,
        "no preview of the URL the person typed (Discord SUPPRESS_EMBEDS, Slack unfurl off)");

      // The page's one request for it: a POST to its own origin, with the person's fields and an empty honeypot.
      assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`POST ${edge.origin}${ENDPOINT}`], `${urlPath}: requests on submit`);
      assert.deepEqual(JSON.parse(requests[0].body), { email: address, role: "agent", site: "https://agent.example", [HONEYPOT]: "", lang });
      assert.deepEqual(errors, [], `${urlPath}: console errors`);
      people.push(`${lang} ${urlPath}`);
    } finally { await context.close(); }
  }
});

// ── bots ────────────────────────────────────────────────────────────────────────────────────
const bots = [];
test("WEB-8: a bot that fills every field fills the honeypot: in the browser it is told ok, and never reaches the notifier", async () => {
  const before = hook.received.length;
  const { context, page, errors } = await open("/", "192.0.2.3");
  try {
    const address = email("bot-browser");
    await page.evaluate((address) => {
      for (const el of document.querySelectorAll("form.ludion-signup input:not([type=hidden])")) el.value = el.type === "email" ? address : el.type === "url" ? "https://spam.example" : "Buy now";
      document.querySelector("form.ludion-signup").requestSubmit();
    }, address);
    assert.equal(await settled(page), "done", "the bot is told what a person is told");
    assert.deepEqual(errors, []);
    assert.equal(notified(hook, address).length, 0);
  } finally { await context.close(); }
  assert.equal(hook.received.length, before, "nothing reached the notifier");
  bots.push("honeypot in the browser");
});

let real;
test("WEB-8: posted directly, a honeypot bot is answered like a person and dropped; a burst from one client passes its limit, then 429, then nothing; another client passes", async () => {
  real = await exercise(edge.origin, hook, 1);
  assert.deepEqual(real.findings, []);
  bots.push("honeypot posted as JSON and as a form", `a burst of ${real.burst.length}: ${real.burst.filter((s) => s === 200).length} through, then 429`);
});

test("WEB-8: a client held at its limit sees it on the page, and nothing more reaches the notifier", async () => {
  const ip = "192.0.2.4";
  for (let i = 0; i < LIMITS.perClient; i++) assert.equal((await direct(edge.origin, ip, { email: email("fill"), lang: "en" })).status, 200);
  const before = hook.received.length;
  for (const [urlPath, lang] of [["/", "en"], ["/ja", "ja"]]) {
    const { context, page, errors } = await open(urlPath, ip);
    try {
      await page.fill('form.ludion-signup input[name="email"]', email("held"));
      await page.click('form.ludion-signup button[type="submit"]');
      assert.equal(await settled(page), "limited", urlPath);
      assert.equal(await page.textContent("form.ludion-signup .signup-status"), STRINGS[lang].states.limited);
      // Chromium reports the 429 itself as a console error; nothing else may be.
      assert.deepEqual(errors.filter((e) => !/status of 429/.test(e)), [], urlPath);
    } finally { await context.close(); }
  }
  assert.equal(hook.received.length, before);
  bots.push("the held client told so on / and /ja");
});

// ── the check bites ─────────────────────────────────────────────────────────────────────────
const FAULTS = [
  ["an endpoint that ignores the honeypot", "honeypot", 'if (String(body[HONEYPOT] ?? "") !== "") return json(200, { ok: true });', ""],
  ["an endpoint with no rate limit", "rate limit", "const retry = limiter.take(client);", "const retry = 0;"],
  ["a rate limit keyed on nothing (one bucket for everyone)", "rate limit (others)", "const retry = limiter.take(client);", 'const retry = limiter.take("");'],
  ["an endpoint that answers ok without notifying", "notifier", 'if (!webhook) return json(503, { error: "unavailable" });', "return json(200, { ok: true });"],
];

test("WEB-8: the check bites: each planted fault in the endpoint is caught by its rule", async () => {
  assert.deepEqual(real?.findings, [], "the real endpoint first");
  const missed = [];
  let tag = 2;
  for (const [name, rule, from, to] of FAULTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-edge-fault-"));
    try {
      for (const f of ["worker.mjs", "signup.mjs", "form.mjs"]) fs.copyFileSync(path.join(EDGE, f), path.join(dir, f));
      const src = fs.readFileSync(path.join(dir, "signup.mjs"), "utf8");
      assert.ok(src.includes(from), `the fault "${name}" must still apply to signup.mjs`);
      fs.writeFileSync(path.join(dir, "signup.mjs"), src.replace(from, to));
      const h = await startNotifier();
      const e = await startEdge({ dist, main: path.join(dir, "worker.mjs"), vars: { SIGNUP_WEBHOOK_URL: h.url } });
      try {
        const { findings } = await exercise(e.origin, h, tag++);
        const rules = [...new Set(findings.map((f) => f.rule))];
        if (!rules.includes(rule)) missed.push(`${name}: wanted "${rule}", got [${rules.join(", ")}]`);
        console.log(`WEB-8 planted "${name}": caught as ${rules.join(", ") || "nothing"}`);
      } finally { await e.stop(); await h.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(missed, [], "planted faults the check did not catch");
  console.log(`WEB-8: people reached the notifier from the form (${people.join(", ")}), one same-origin POST each; bots dropped (${bots.join("; ")}), none reached the notifier; ${FAULTS.length}/${FAULTS.length} planted faults caught; the Worker in workerd (wrangler dev), the notifier a stub`);
});
