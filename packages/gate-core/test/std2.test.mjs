// STD-2 (docs/MISSION.md §4): through the Gate path, reject tampering, another key, another
// authority, expired, future `created`, lifetime > 1h (> 60s without a nonce), a wrong tag, and a Signature-Agent
// dictionary key that does not match the signature's covered member / label.
// Every negative case starts from a request that is VERIFIED and changes exactly one thing.
// Expected classes follow spec §10.8: keyid not in the directory → UNVERIFIED (not attributable),
// anything that fails RFC 9421 / Web Bot Auth verification → SPOOFED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { component } from "http-message-sig";
import { keypair, signed, harness, withFields, fieldOf, retarget, rejected, AGENT, ATTACKER, SITE, NOW_S, NOW_MS } from "./support.mjs";

const agent = await keypair();
const attacker = await keypair();
const gate = await harness({ agentKeys: [agent], attackerKeys: [attacker] });
const inspect = (req) => gate.inspect(req);

async function assertRejected(req, classes, why) {
  const r = await inspect(req);
  assert.deepEqual(rejected(r, { victim: AGENT }), [], `${why}: ${JSON.stringify(r.cls)}`);
  assert.ok(classes.includes(r.cls.class), `${why}: expected ${classes.join("|")}, got ${r.cls.class} (${r.cls.reason ?? ""} ${r.cls.detail ?? ""})`);
  return r;
}
async function assertVerified(req, why) {
  const r = await inspect(req);
  assert.equal(r.cls.class, "VERIFIED", `${why}: ${JSON.stringify(r.cls)}`);
  assert.equal(r.cls.identifier, AGENT, why);
  assert.equal(r.decision.action, "allow", why);
  return r;
}

test("STD-2: baseline — an honest signature is VERIFIED on the Pressure-2 route (the control for every case)", async () => {
  await assertVerified(await signed({ key: agent }), "GET");
  await assertVerified(await signed({ key: agent, method: "POST", body: '{"sku":1}' }), "POST with content-digest");
  await assertVerified(await signed({ key: agent, agentHeader: `agent2="${AGENT}"`, agentKey: "agent2", label: "sig2" }), "dictionary key differs from the label (App. E.2.1 shape)");
});

test("STD-2: tampered signature bytes → SPOOFED", async () => {
  const req = await signed({ key: agent });
  const sig = fieldOf(req, "signature");
  const b = Buffer.from(sig.slice(sig.indexOf(":") + 1, -1), "base64"); b[5] ^= 0x01;
  await assertRejected(withFields(req, { signature: `sig1=:${b.toString("base64")}:` }), ["SPOOFED"], "one flipped bit");
});

test("STD-2: tampered covered components and parameters → SPOOFED", async () => {
  const post = await signed({ key: agent, method: "POST", body: '{"sku":1}' });
  await assertRejected(withFields(post, { "content-digest": `sha-256=:${Buffer.alloc(32).toString("base64")}:` }), ["SPOOFED"], "content-digest swapped");
  await assertRejected({ ...post, method: "PUT" }, ["SPOOFED"], "@method changed");
  await assertRejected(retarget(post, `${SITE}/checkout/2`), ["SPOOFED"], "@path changed");
  const get = await signed({ key: agent });
  const input = fieldOf(get, "signature-input");
  await assertRejected(withFields(get, { "signature-input": input.replace(/expires=\d+/, `expires=${NOW_S + 30}`) }), ["SPOOFED"], "expires rewritten");
  await assertRejected(withFields(get, { "signature-input": input.replace(/nonce="[^"]+"/, `nonce="${Buffer.alloc(64, 7).toString("base64")}"`) }), ["SPOOFED"], "nonce rewritten");
  await assertRejected(withFields(get, { "signature-agent": `sig1="${ATTACKER}"` }), ["SPOOFED", "UNVERIFIED"], "Signature-Agent redirected to another directory");
});

test("STD-2: another key → never VERIFIED as the agent", async () => {
  // Signed with the attacker's key while claiming the agent's keyid: the published key does not verify it.
  await assertRejected(await signed({ key: attacker, keyid: agent.kid }), ["SPOOFED"], "claims the agent's keyid");
  // Signed with the attacker's own keyid under the agent's Signature-Agent: not in that directory.
  const r = await assertRejected(await signed({ key: attacker }), ["UNVERIFIED"], "keyid absent from the agent's directory");
  assert.equal(r.cls.reason, "unknown-key");
});

test("STD-2: another authority → SPOOFED", async () => {
  const req = await signed({ key: agent, url: `${SITE}/checkout/1` });
  await assertRejected(retarget(req, "https://other-shop.example/checkout/1"), ["SPOOFED"], "signed for shop.example, sent to other-shop.example");
  await assertRejected(retarget(req, "https://shop.example:8443/checkout/1"), ["SPOOFED"], "same host, other port");
  // A signature that does not cover a bare @authority / @target-uri binds to no site at all.
  await assertRejected(await signed({ key: agent, components: [component("signature-agent", { key: "sig1" })] }), ["SPOOFED"], "@authority not covered");
});

test("STD-2: expired → SPOOFED (±30s skew is the only grace)", async () => {
  await assertRejected(await signed({ key: agent, created: NOW_S - 100, expires: NOW_S - 40 }), ["SPOOFED"], "expired 40s ago");
  await assertRejected(await signed({ key: agent, created: NOW_S - 91, expires: NOW_S - 31 }), ["SPOOFED"], "expired 31s ago");
  await assertVerified(await signed({ key: agent, created: NOW_S - 89, expires: NOW_S - 29 }), "expired 29s ago is inside the skew");
  await assertRejected(await signed({ key: agent, created: NOW_S - 3600, expires: NOW_S - 3540 }), ["SPOOFED"], "an hour old");
});

test("STD-2: future created → SPOOFED (±30s skew is the only grace)", async () => {
  await assertRejected(await signed({ key: agent, created: NOW_S + 31 }), ["SPOOFED"], "created 31s ahead");
  await assertRejected(await signed({ key: agent, created: NOW_S + 3600 }), ["SPOOFED"], "created an hour ahead");
  await assertVerified(await signed({ key: agent, created: NOW_S + 29 }), "created 29s ahead is inside the skew");
});

test("STD-2: lifetime over an hour, or over 60s without a nonce → SPOOFED", async () => {
  await assertRejected(await signed({ key: agent, lifetime: 3601 }), ["SPOOFED"], "3601s");
  await assertRejected(await signed({ key: agent, lifetime: 86_400 }), ["SPOOFED"], "one day");
  await assertRejected(await signed({ key: agent, lifetime: 61, nonce: null }), ["SPOOFED"], "61s without a nonce");
  await assertRejected(await signed({ key: agent, lifetime: 3600, nonce: null }), ["SPOOFED"], "an hour without a nonce");
  await assertVerified(await signed({ key: agent, lifetime: 3600 }), "an hour with a nonce is the limit");
  await assertVerified(await signed({ key: agent, lifetime: 60, nonce: null }), "60s needs no nonce");
});

test("STD-2: missing expires / created / tag → SPOOFED", async () => {
  const noExpires = await signed({ key: agent });
  const input = fieldOf(noExpires, "signature-input");
  await assertRejected(withFields(noExpires, { "signature-input": input.replace(/;expires=\d+/, "") }), ["SPOOFED"], "expires removed");
  await assertRejected(withFields(noExpires, { "signature-input": input.replace(/;created=\d+/, "") }), ["SPOOFED"], "created removed");
  await assertRejected(await signed({ key: agent, tag: null }), ["SPOOFED"], "signed without a tag");
  await assertRejected(await signed({ key: agent, expires: null }), ["SPOOFED"], "signed without expires");
});

test("STD-2: wrong tag → SPOOFED (a validly signed, non-web-bot-auth signature is not a Web Bot Auth verification)", async () => {
  const r = await assertRejected(await signed({ key: agent, tag: "not-web-bot-auth" }), ["SPOOFED"], "tag not-web-bot-auth");
  assert.notEqual(r.cls.reason, "resolver", "a profile violation is not a discovery failure");
  await assertRejected(await signed({ key: agent, tag: "Web-Bot-Auth" }), ["SPOOFED"], "tag differs only in case");
  const input = fieldOf(await signed({ key: agent }), "signature-input");
  assert.match(input, /tag="web-bot-auth"/);
});

test("STD-2: Signature-Agent dictionary key vs the signature's covered member and label", async () => {
  // Covered key names a member the dictionary sent does not have (signed with sig1 present, then dropped).
  const both = await signed({ key: agent, agentHeader: `sig1="${AGENT}", agent1="${AGENT}"`, agentKey: "sig1" });
  await assertRejected(withFields(both, { "signature-agent": `agent1="${AGENT}"` }), ["SPOOFED"], "covers key=sig1, dictionary has only agent1");
  // Dictionary rewritten after signing so the covered member points elsewhere.
  const req = await signed({ key: agent, agentHeader: `agent1="${AGENT}"`, agentKey: "agent1" });
  await assertRejected(withFields(req, { "signature-agent": `agent2="${AGENT}"` }), ["SPOOFED"], "member renamed after signing");
  // Bare "signature-agent" covered while the header is a dictionary: which member is meant is ambiguous.
  await assertRejected(await signed({ key: agent, components: ["@authority", "signature-agent"] }), ["SPOOFED"], "dictionary header, bare component");
  // Two members covered at once: exactly one is allowed.
  await assertRejected(await signed({ key: agent, agentHeader: `sig1="${AGENT}", agent2="${ATTACKER}"`,
    components: ["@authority", component("signature-agent", { key: "sig1" }), component("signature-agent", { key: "agent2" })] }), ["SPOOFED"], "two members covered");
  // Signature-Input label and Signature label differ.
  const s = await signed({ key: agent });
  await assertRejected(withFields(s, { signature: fieldOf(s, "signature").replace(/^sig1=/, "sig2=") }), ["SPOOFED"], "Signature label sig2 vs Signature-Input label sig1");
  // Multi-member dictionary: the resolved identifier is the covered member, never another one.
  const multi = await signed({ key: attacker, agentHeader: `a="${AGENT}", b="${ATTACKER}"`, agentKey: "b", label: "sig1" });
  const r = await inspect(multi);
  assert.equal(r.cls.class, "VERIFIED");
  assert.equal(r.cls.identifier, ATTACKER, "attributed to the member the signature covers");
  const lying = await signed({ key: attacker, agentHeader: `a="${AGENT}", b="${ATTACKER}"`, agentKey: "a", label: "sig1" });
  await assertRejected(lying, ["UNVERIFIED"], "attacker key under the agent's member");
});

test("STD-2: Gate clock drives the checks (no wall-clock leak)", async () => {
  const later = await harness({ agentKeys: [agent], now: () => NOW_MS + 120_000 });
  const r = await later.inspect(await signed({ key: agent }));
  assert.equal(r.cls.class, "SPOOFED", "a signature valid at NOW is expired two minutes later");
});
