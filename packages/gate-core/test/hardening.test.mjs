// GATE-7 fixes, pinned from both sides: each attack that once got through the corpus
// (accept/attacks/) is refused here, and the honest request next to it still passes, so a
// fix cannot quietly turn into over-blocking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keypair, signed, harness, withFields, retarget, AGENT, SITE, NOW_MS, NOW_S } from "./support.mjs";

const agent = await keypair();
const other = await keypair();
let t = NOW_MS;
const gate = await harness({ agentKeys: [agent, other], now: () => t });
const at = async (s, req) => { t = NOW_MS + s * 1000; return (await gate.inspect(req)).cls; };

test("GATE-7: a nonce is remembered through the skew tail; a fresh signature there still verifies", async () => {
  const req = await signed({ key: agent });
  assert.equal((await at(0, req)).class, "VERIFIED");
  const replay = await at(80, req); // expires at +60, accepted until +90
  assert.equal(replay.class, "SPOOFED");
  assert.equal(replay.reason, "replay");
  assert.equal((await at(80, await signed({ key: agent, created: NOW_S + 75 }))).class, "VERIFIED");
});

test("GATE-7: nonce-less signatures — the same request twice is a replay; the same signature on another path is the signer's choice", async () => {
  const req = await signed({ key: agent, nonce: null, created: NOW_S + 200 });
  assert.equal((await at(200, req)).class, "VERIFIED");
  assert.equal((await at(201, req)).reason, "replay");
  assert.equal((await at(202, retarget(req, `${SITE}/checkout/2`))).class, "VERIFIED", "GET does not cover @path; not a replay of the same request");
});

test("GATE-7: nonces are per key — another key reusing a nonce value is not burned", async () => {
  const nonce = Buffer.alloc(64, 9).toString("base64");
  assert.equal((await at(300, await signed({ key: agent, nonce, created: NOW_S + 300 }))).class, "VERIFIED");
  assert.equal((await at(300, await signed({ key: other, nonce, created: NOW_S + 300 }))).class, "VERIFIED");
});

test("GATE-7: fields that claim an agent without a complete signature are SPOOFED; a lone legacy Signature is not a claim", async () => {
  const browser = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" };
  const mk = (fields) => ({ kind: "request", method: "GET", targetUri: `${SITE}/checkout/1`, fields: Object.entries({ ...browser, ...fields }).map(([name, value]) => ({ name, value })) });
  for (const f of [{ "signature-agent": `sig1="${AGENT}"` }, { "signature-input": 'sig1=("@authority");created=1' }, { "ludion-staple": "a.b.c" }, { "ludion-mandate": "a.b.c" }]) {
    const c = await at(400, mk(f));
    assert.equal(c.class, "SPOOFED", JSON.stringify(f));
    assert.equal(c.reason, "unsigned_claim");
  }
  assert.equal((await at(400, mk({ signature: 'keyId="https://mastodon.example/actor#main-key",signature="AAAA"' }))).class, "UNKNOWN");
  assert.equal((await at(400, mk({}))).class, "UNKNOWN");
});

test("GATE-7: a state-changing request that announces a body must bind it; an empty one need not", async () => {
  const cover = ["@authority", { name: "signature-agent", params: { key: "sig1" } }, "@method", "@path"];
  const { component } = await import("http-message-sig");
  const comps = cover.map((c) => (typeof c === "string" ? c : component(c.name, c.params)));
  const created = NOW_S + 500;
  assert.equal((await at(500, await signed({ key: agent, method: "POST", created, headers: { "content-length": "0" }, components: comps }))).class, "VERIFIED");
  assert.equal((await at(500, await signed({ key: agent, method: "DELETE", created, components: comps }))).class, "VERIFIED");
  assert.equal((await at(500, await signed({ key: agent, method: "POST", created, headers: { "content-length": "12" }, components: comps }))).class, "SPOOFED");
  assert.equal((await at(500, await signed({ key: agent, method: "PATCH", created, headers: { "transfer-encoding": "chunked" }, components: comps }))).class, "SPOOFED");
  assert.equal((await at(500, await signed({ key: agent, method: "POST", created, body: '{"sku":1}', headers: { "content-length": "9" } }))).class, "VERIFIED");
});

test("GATE-7: replay detection does not need the Signature field order or header casing to match", async () => {
  const req = await signed({ key: agent, created: NOW_S + 600 });
  assert.equal((await at(600, req)).class, "VERIFIED");
  const shuffled = { ...req, fields: [...req.fields].reverse().map((f) => ({ ...f, name: f.name.toUpperCase() })) };
  assert.equal((await at(601, shuffled)).reason, "replay");
  assert.equal((await at(602, withFields(req, { "user-agent": "Changed/1.0" }))).reason, "replay", "uncovered fields do not make a new request");
});
