// PRS-3 (±): a Mandate's per_day is the site's, counted across all of its Gates (the human's rule
// after Codex audit #4). One record the site's Gates share, updated atomically; the Registry holds
// no spend (spec §8 invariant 8: no Registry is even running here).
//   + inside the limit, charges spread over two Gate processes all pass;
//   − the charge one past the total is refused at whichever Gate it reaches, also when twelve race
//     over both processes at once (exactly per_day pass); a Gate with no shared record refuses a
//     counted Mandate's charge (fail closed), while the per-charge maximum and the currency still
//     hold at any Gate; two Workers Gates handed one ledger share the count.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { component } from "http-message-sig";
import { ludionGate } from "@ludion/gate-node";
import { withLudion, ludion } from "@ludion/gate-workers";
import { generateSiteKey, MANDATE_TYP } from "@ludion/gate-core";
import { signJws } from "@ludion/gate-core/staple";
import { keypair, signed, staple, AGENT, REGISTRY_ISS } from "../../gate-core/test/support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const agent = await keypair(), registry = await keypair();
const SUB = "dvr-prs3prs3prs3prs3";
const now = () => Math.floor(Date.now() / 1000);
const stapleNow = () => staple(registry, { sub: SUB, jkt: agent.kid, iat: now() - 5, exp: now() + 3000 }); // a Staple lives an hour at most
let jtiN = 0;
const mandate = (limits) => signJws(registry.privateKey, registry.kid, MANDATE_TYP, {
  iss: REGISTRY_ISS, sub: SUB, prn: "pw-prs3", aud: "https://shop.example", scope: ["checkout"], limits,
  iat: now() - 60, exp: now() + 86_400, jti: `mdt-prs3-${process.pid}-${++jtiN}`,
});
/** Headers of a fresh signed checkout carrying the Staple and the Mandate (a new nonce each time). */
async function checkoutHeaders(m, url = "https://shop.example/checkout/1") {
  const desc = await signed({ key: agent, method: "POST", url, created: now(), body: CART,
    headers: { "ludion-staple": await stapleNow(), "ludion-mandate": m }, extraComponents: [component("ludion-staple"), component("ludion-mandate")] });
  return Object.fromEntries(desc.fields.map((f) => [f.name, f.value]));
}
const LIMITS = { checkout_max: 50_000, currency: "JPY", per_day: 3 };
const CART = '{"cart":"c-1"}'; // the body each checkout signs (Content-Digest) and sends

// ── two Gate processes, one SQLite ledger ──────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-prs3-"));
const procs = [];
after(() => { for (const p of procs) p.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ } });
async function gateProcess() {
  const env = { ...process.env, LUDION_PRS3: JSON.stringify({ registry: registry.publicJwk, issuer: REGISTRY_ISS, agentUri: AGENT,
    agentKey: { ...agent.publicJwk, use: "sig" }, ledger: path.join(dir, "ledger.sqlite") }) };
  const p = spawn(process.execPath, ["--no-warnings", path.join(HERE, "prs3-site.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
  procs.push(p);
  const port = await new Promise((ok, fail) => {
    let out = "";
    p.stdout.on("data", (d) => { out += d; const m = /READY (\d+)/.exec(out); if (m) ok(Number(m[1])); });
    p.on("exit", (code) => fail(new Error(`Gate process exited ${code}`)));
  });
  return port;
}
// Started on first use, so this file loads (and the overspend below shows) on a Gate without ledgers.
let pair;
const processes = () => (pair ??= Promise.all([gateProcess(), gateProcess()]));

function post(port, headers, { total = 12_000, currency = "JPY" } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request(`http://127.0.0.1:${port}/checkout/1?total=${total}&currency=${currency}`, { method: "POST", headers: { ...headers, host: "shop.example" }, agent: false }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => ok({ status: res.statusCode, error: res.headers["ludion-error"], ...JSON.parse(Buffer.concat(c).toString() || "{}") }));
    });
    req.on("error", fail); req.end(CART);
  });
}
const passed = (r) => r.status === 200 && r.ok === true && r.enforced === true;

/** A gate-node Gate of the site on a local server (no ledger unless given); its port. */
async function inProcessGate(extra = {}) {
  const mw = await ludionGate({ siteId: "site-prs3-local", siteKey: (await generateSiteKey()).privateJwk, authorities: ["shop.example"],
    routes: [{ match: "/checkout/**", pressure: 2, require: { scope: "checkout" } }], registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS,
    resolver: { fetch: async () => new Response("", { status: 404 }) }, ...extra });
  await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  const srv = http.createServer((req, res) => mw(req, res, async () => {
    const q = new URL(req.url, "http://x").searchParams;
    const v = await req.ludion.charge({ amount: Number(q.get("total")), currency: q.get("currency") });
    res.writeHead(v.ok ? 200 : v.status, { "content-type": "application/json", ...(v.headers ?? {}) });
    res.end(JSON.stringify({ ok: v.ok, enforced: v.enforced, reason: v.reason ?? null, remaining: v.remaining ?? null }));
  }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  return srv.address().port;
}

test("PRS-3: two Gates of one site never spend a per_day Mandate past its total between them (Codex audit #4)", async () => {
  // Two Gates as a site deploys them by default (two instances, nothing shared declared). per_day 1:
  // at most one charge may pass across both. Counting per Gate lets each pass one.
  const [X, Y] = [await inProcessGate(), await inProcessGate()];
  const m = await mandate({ ...LIMITS, per_day: 1 });
  const out = [await post(X, await checkoutHeaders(m)), await post(Y, await checkoutHeaders(m))];
  assert.ok(out.filter(passed).length <= 1, `${out.filter(passed).length} charges passed for per_day 1: ${JSON.stringify(out)}`);
});

test("PRS-3: inside per_day, charges spread over two Gate processes pass; the next one is refused at either Gate", async () => {
  const [A, B] = await processes();
  const m = await mandate(LIMITS);
  const seq = [];
  for (const port of [A, B, A]) seq.push(await post(port, await checkoutHeaders(m)));
  assert.ok(seq.every(passed), JSON.stringify(seq));
  assert.deepEqual(seq.map((r) => r.remaining?.per_day), [2, 1, 0], "the count is one count, whichever Gate took the charge");
  for (const port of [B, A]) {
    const r = await post(port, await checkoutHeaders(m));
    assert.equal(r.status, 403, JSON.stringify(r));
    assert.equal(r.error, "mandate_scope");
    assert.equal(r.reason, "per_day");
  }
});

test("PRS-3: twelve charges racing over both processes — exactly per_day pass, every time", async () => {
  const [A, B] = await processes();
  for (let round = 0; round < 5; round++) {
    const m = await mandate(LIMITS);
    const all = await Promise.all(await Promise.all(Array.from({ length: 12 }, async (_, i) => post(i % 2 ? A : B, await checkoutHeaders(m)))));
    const ok = all.filter(passed).length;
    assert.equal(ok, 3, `round ${round}: ${ok} passed — ${JSON.stringify(all.map((r) => r.status))}`);
    assert.ok(all.filter((r) => !passed(r)).every((r) => r.status === 403 && r.reason === "per_day"), "the rest are per_day refusals");
  }
});

test("PRS-3: a Gate with no shared record refuses a counted Mandate's charge; per-charge limits hold at any Gate", async () => {
  const C = await inProcessGate();
  const counted = await mandate(LIMITS);
  let r = await post(C, await checkoutHeaders(counted));
  assert.equal(r.status, 403);
  assert.equal(r.reason, "no_shared_ledger", "fail closed: nothing here can count per_day for the site");
  const uncounted = await mandate({ checkout_max: 50_000, currency: "JPY" });
  assert.ok(passed(await post(C, await checkoutHeaders(uncounted))), "no per_day: nothing to count, the charge holds");
  r = await post(C, await checkoutHeaders(uncounted), { total: 50_001 });
  assert.equal(r.reason, "over_limit");
  r = await post(C, await checkoutHeaders(uncounted), { currency: "USD", total: 100 });
  assert.equal(r.reason, "currency");
});

test("PRS-3: two Workers Gates given one ledger share the count; without one, a counted Mandate is refused", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).startsWith(AGENT)
    ? new Response(JSON.stringify({ keys: [{ ...agent.publicJwk, use: "sig" }] }), { headers: { "content-type": "application/http-message-signatures-directory+json" } })
    : new Response("", { status: 404 }));
  try {
    const app = { async fetch(request) {
      const u = new URL(request.url);
      const v = await ludion(request).charge({ amount: Number(u.searchParams.get("total")), currency: u.searchParams.get("currency") });
      return new Response(JSON.stringify({ ok: v.ok, enforced: v.enforced, reason: v.reason ?? null }), { status: v.ok ? 200 : v.status });
    } };
    const env = { LUDION: { site_id: "site-prs3-workers", authorities: ["shop.example"], routes: [{ match: "/checkout/**", pressure: 2, require: { scope: "checkout" } }],
      registry: { keys: [registry.publicJwk], issuer: REGISTRY_ISS } } };
    const { memoryLedger } = await import("@ludion/gate-core");
    const shared = memoryLedger();
    const [w1, w2] = [withLudion(app, { mandateLedger: shared }), withLudion(app, { mandateLedger: shared })];
    const send = async (w, m) => {
      const res = await w.fetch(new Request("https://shop.example/checkout/1?total=12000&currency=JPY", { method: "POST", headers: await checkoutHeaders(m), body: CART }), env, { waitUntil() {} });
      return { status: res.status, ...(await res.json()) };
    };
    const m = await mandate(LIMITS);
    const out = [];
    for (const w of [w1, w2, w1, w2]) out.push(await send(w, m));
    assert.deepEqual(out.map((r) => r.status), [200, 200, 200, 403], JSON.stringify(out));
    assert.equal(out[3].reason, "per_day");
    const alone = withLudion(app);
    const r = await send(alone, await mandate(LIMITS));
    assert.equal(r.status, 403);
    assert.equal(r.reason, "no_shared_ledger");
  } finally { globalThis.fetch = realFetch; }
});

test("PRS-3: a limit the Gate cannot enforce (a total over a period, anything unknown) is refused, with a ledger or without", async () => {
  // The human's rule (2026-10-02): a limit that adds up over a period needs the record as per_day
  // does; v0 knows only checkout_max, currency and per_day, so any other limit cannot be held here
  // and its charge is refused rather than let through unchecked.
  const withLedger = await inProcessGate({ mandateLedger: (await import("@ludion/gate-core")).memoryLedger() });
  const without = await inProcessGate();
  for (const limits of [
    { checkout_max: 50_000, currency: "JPY", day_total_max: 60_000 },
    { checkout_max: 50_000, currency: "JPY", per_day: 3, month_total_max: 100_000 },
    { checkout_max: 50_000, currency: "JPY", per_week: 2 },
  ]) {
    for (const [gate, where] of [[withLedger, "with a ledger"], [without, "without a ledger"]]) {
      const r = await post(gate, await checkoutHeaders(await mandate(limits)));
      assert.equal(r.status, 403, `${JSON.stringify(limits)} ${where}: ${JSON.stringify(r)}`);
      assert.equal(r.reason, "unenforceable_limit", `${JSON.stringify(limits)} ${where}`);
    }
  }
  // Control: the limits the Gate does know still pass with the record.
  assert.ok(passed(await post(withLedger, await checkoutHeaders(await mandate(LIMITS)))), "known limits, with a ledger");
});
