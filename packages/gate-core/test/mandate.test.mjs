// Mandate v0 (spec §10.6) at the Gate, fast: the Mandate a request carries, the charge the site
// makes, the revocation entries that withdraw one, and the primitives the Registry's passkey
// check uses. The full world (Registry, passkey consent, Gates over HTTP) is PRS-2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { component } from "http-message-sig";
import { createRevocationList, memoryLedger, MANDATE_TYP } from "../src/index.mjs";
import { signJws, derToRawEcdsa, verifyPasskeySignature, passkeyPublicJwk, hmacSha256 } from "../src/staple.mjs";
import { gateConfig } from "../src/config.mjs";
import { keypair, signed, harness, staple, NOW_MS, NOW_S, SITE, REGISTRY_ISS } from "./support.mjs";

const DIVER = "dvr-aaaaaaaaaaaaaaaa", OTHER_DIVER = "dvr-bbbbbbbbbbbbbbbb";
const LIMITS = { checkout_max: 50_000, currency: "JPY", per_day: 2 };
const ROUTES = [
  { match: "/checkout/**", pressure: 2, require: { scope: "checkout" } },
  { match: "/watch/**", pressure: 1, require: { scope: "checkout" } },
  { match: "/depth/**", pressure: 2, require: { depth: 1 } },
];

const mandateOf = (registry, p = {}) => signJws(registry.privateKey, registry.kid, MANDATE_TYP, {
  iss: REGISTRY_ISS, sub: DIVER, prn: "pw-abc", aud: SITE, scope: ["read", "checkout"], limits: LIMITS,
  iat: NOW_S - 60, exp: NOW_S + 86_400, jti: "mdt-aaaaaaaaaaaaaaaa", ...p,
});

async function world(o = {}) {
  const agent = await keypair(), registry = await keypair();
  const gate = await harness({ agentKeys: [agent], registry, routes: ROUTES, ...o });
  /** A POST carrying a Staple (unless `stapled` is false) and the given Mandate. */
  const send = async (mandate, { path = "/checkout/1", stapled = true, stapleFields = {}, url } = {}) => {
    const st = await staple(registry, { jkt: agent.kid, ...stapleFields });
    const headers = { ...(stapled ? { "ludion-staple": st } : {}), ...(mandate ? { "ludion-mandate": mandate } : {}) };
    const extra = [...(stapled ? [component("ludion-staple")] : []), ...(mandate ? [component("ludion-mandate")] : [])];
    return gate.inspect(await signed({ key: agent, method: "POST", url: url ?? `${SITE}${path}`, headers, extraComponents: extra }));
  };
  return { agent, registry, gate, send };
}

test("mandate: a Registry Mandate for this Diver and site is read, and opens the route its scope names", async () => {
  const w = await world();
  const r = await w.send(await mandateOf(w.registry));
  assert.equal(r.cls.class, "VERIFIED");
  assert.equal(r.cls.mandate.jti, "mdt-aaaaaaaaaaaaaaaa");
  assert.equal(r.decision.action, "allow");
  const none = await w.send(undefined);
  assert.equal(none.decision.error, "mandate_required");
  const readOnly = await w.send(await mandateOf(w.registry, { scope: ["read"], limits: undefined }));
  assert.equal(readOnly.decision.error, "mandate_scope");
});

test("mandate: a delegation the request was not given is SPOOFED; one that does not hold here and now is no Mandate", async () => {
  const w = await world();
  const forger = await keypair();
  const good = JSON.parse(Buffer.from((await mandateOf(w.registry)).split(".")[1], "base64url"));
  const spoofed = {
    "signed by another key": await signJws(forger.privateKey, w.registry.kid, MANDATE_TYP, good),
    "another Diver's": await mandateOf(w.registry, { sub: OTHER_DIVER }),
    "a Staple passed off as a Mandate": await staple(w.registry, { jkt: w.agent.kid }),
    "another typ": await signJws(w.registry.privateKey, w.registry.kid, "ludion-revocation+jwt", good),
    "another issuer": await mandateOf(w.registry, { iss: "https://registry.evil" }),
    "a checkout Mandate without limits": await mandateOf(w.registry, { limits: undefined }),
    "a lifetime over 7 days": await mandateOf(w.registry, { exp: NOW_S - 60 + 8 * 86_400 }),
    "issued in the future": await mandateOf(w.registry, { iat: NOW_S + 3600, exp: NOW_S + 7200 }),
    "no jti": await mandateOf(w.registry, { jti: undefined }),
    "not a JWS": "e30.e30.e30",
  };
  for (const [what, m] of Object.entries(spoofed)) {
    const r = await w.send(m);
    assert.equal(r.cls.class, "SPOOFED", what); assert.equal(r.cls.reason, "invalid_mandate", what);
    assert.equal(r.decision.error, "invalid_signature", what);
    // Found by GATE-7's mandate-swap attacks: the Staple had been read before the Mandate failed,
    // and the SPOOFED result still carried its standing.
    assert.deepEqual({ depth: r.cls.depth, diverId: r.cls.diverId, staple: r.cls.staple, ballast: r.cls.ballast?.status },
      { depth: 0, diverId: undefined, staple: null, ballast: "none" }, `${what}: a spoof carries no Staple standing`);
  }
  const absent = {
    audience: [await mandateOf(w.registry, { aud: "https://other.example" })],
    expired: [await mandateOf(w.registry, { iat: NOW_S - 7200, exp: NOW_S - 31 })],
    no_staple: [await mandateOf(w.registry), { stapled: false }],
  };
  for (const [code, [m, o]] of Object.entries(absent)) {
    const r = await w.send(m, o);
    assert.equal(r.cls.class, "VERIFIED", code); assert.equal(r.cls.mandate, undefined, code); assert.equal(r.cls.mandateError, code);
    assert.equal(r.decision.error, "mandate_required", code);
  }
  const inSkew = await w.send(await mandateOf(w.registry, { iat: NOW_S - 7200, exp: NOW_S - 29 }));
  assert.ok(inSkew.cls.mandate, "30 s of clock skew, as for Staples");
});

test("mandate: the audience is the site the request is for (not any authority the Gate holds), or a category it declares", async () => {
  const pinned = await world({ authorities: ["shop.example", "www.shop.example"] });
  assert.ok((await pinned.send(await mandateOf(pinned.registry))).cls.mandate, "the site the request is for");
  // Codex audit #6: a Gate with several authorities used to accept a Mandate for any of them.
  assert.equal((await pinned.send(await mandateOf(pinned.registry, { aud: "https://www.shop.example" }))).cls.mandateError, "audience", "another authority of the same Gate");
  assert.ok((await pinned.send(await mandateOf(pinned.registry, { aud: "https://www.shop.example" }), { url: "https://www.shop.example/checkout/1" })).cls.mandate, "…which holds when the request is for it");
  assert.equal((await pinned.send(await mandateOf(pinned.registry), { url: "https://www.shop.example/checkout/1" })).cls.mandateError, "audience", "and the other way round");
  assert.equal((await pinned.send(await mandateOf(pinned.registry, { aud: "https://shop.example/" }))).cls.mandateError, "audience", "an origin, exactly");
  assert.equal((await pinned.send(await mandateOf(pinned.registry, { aud: "https://evil.shop.example" }))).cls.mandateError, "audience");
  assert.equal((await pinned.send(await mandateOf(pinned.registry, { aud: "cat:ecommerce" }))).cls.mandateError, "audience", "a category the site does not declare");
  const cat = await world({ categories: ["ecommerce"] });
  assert.ok((await cat.send(await mandateOf(cat.registry, { aud: "cat:ecommerce" }))).cls.mandate, "a declared category");
  assert.equal((await cat.send(await mandateOf(cat.registry, { aud: "cat:travel" }))).cls.mandateError, "audience");
  const unpinned = await world({ authorities: null, pressure: 1, routes: [{ match: "/checkout/**", pressure: 1 }] });
  assert.ok((await unpinned.send(await mandateOf(unpinned.registry))).cls.mandate, "unpinned: the request's own authority");
  assert.equal((await unpinned.send(await mandateOf(unpinned.registry, { aud: "https://other.example" }))).cls.mandateError, "audience");
  await assert.rejects(() => harness({ agentKeys: [], categories: ["E-Commerce"] }), /categories/);
});

test("mandate: withdrawn through the revocation list or the Staple, never taking the Diver with it", async () => {
  const w = await world();
  // The list as the Gate holds it, fed entries the way the stream would.
  const l = createRevocationList();
  assert.equal(l.add({ seq: 3, sub: DIVER, scope: "mandate", mdt: ["mdt-aaaaaaaaaaaaaaaa"], reason: "withdrawn" }), true);
  assert.equal(l.match({ sub: DIVER }), undefined, "a withdrawn Mandate is not a revoked Diver");
  assert.ok(l.match({ mandate: "mdt-aaaaaaaaaaaaaaaa" }));
  assert.equal(l.match({ mandate: "mdt-bbbbbbbbbbbbbbbb" }), undefined);
  assert.equal(l.add({ seq: 4, sub: DIVER, scope: "something-newer", jkt: [w.agent.kid] }), false, "an unknown scope revokes nothing");
  assert.equal(l.match({ jkt: w.agent.kid }), undefined);
  assert.equal(l.lastSeq, 4, "but the stream still resumes after it");
  assert.equal(l.add({ seq: 5, sub: OTHER_DIVER }), true, "an entry without scope is a whole Diver, as before");
  assert.ok(l.match({ sub: OTHER_DIVER }));

  const viaStaple = await w.send(await mandateOf(w.registry), { stapleFields: { mrev: ["mdt-zzzzzzzzzzzzzzzz", "mdt-aaaaaaaaaaaaaaaa"] } });
  assert.equal(viaStaple.cls.mandateError, "revoked"); assert.equal(viaStaple.decision.error, "mandate_required");
  assert.equal(viaStaple.cls.class, "VERIFIED", "the Diver stays VERIFIED");
});

test("mandate: charge() holds a payment to the limits where the route asks for a Mandate, and nowhere else", async () => {
  let t = NOW_MS;
  const w = await world({ now: () => t, mandateLedger: memoryLedger() });
  const r = await w.send(await mandateOf(w.registry, { exp: NOW_S + 3 * 86_400 }));
  const pay = (amount, currency = "JPY", res = r) => w.gate.charge(res, { amount, currency });
  assert.deepEqual(await pay(50_000), { ok: true, enforced: true, remaining: { per_day: 1 } });
  for (const [amount, currency, reason] of [[50_001, "JPY", "over_limit"], [100, "USD", "currency"], [0, "JPY", "bad_amount"], [-5, "JPY", "bad_amount"],
    [12.5, "JPY", "bad_amount"], [Number.NaN, "JPY", "bad_amount"], ["100", "JPY", "bad_amount"], [2 ** 60, "JPY", "bad_amount"]]) {
    const v = await pay(amount, currency);
    assert.equal(v.ok, false, `${amount} ${currency}`); assert.equal(v.reason, reason); assert.equal(v.error, "mandate_scope"); assert.equal(v.status, 403);
    assert.equal(v.headers["Ludion-Error"], "mandate_scope"); assert.match(v.headers.Link, /\/e\/mandate_scope>; rel="help"/);
  }
  assert.equal((await pay(1)).ok, true, "refusals are not counted");
  assert.equal((await pay(1)).reason, "per_day");
  t += 86_400_000 - 1;
  assert.equal((await pay(1)).reason, "per_day", "still within 24 hours of the first");
  t += 2;
  assert.equal((await pay(1)).ok, true, "a rolling 24 hours");
  t = (NOW_S + 3 * 86_400 + 31) * 1000;
  assert.equal((await pay(1)).reason, "expired", "a Mandate that lapsed while the site worked");
  t = NOW_MS;

  const human = await w.gate.inspect({ kind: "request", method: "POST", targetUri: `${SITE}/checkout/1`, fields: [{ name: "user-agent", value: "Mozilla/5.0" }] });
  assert.deepEqual(await w.gate.charge(human, { amount: 10 ** 9, currency: "XXX" }), { ok: true, enforced: false }, "never on humans");
  const watch = await w.send(undefined, { path: "/watch/1" });
  assert.deepEqual(await w.gate.charge(watch, { amount: 10 ** 9, currency: "XXX" }), { ok: true, enforced: false }, "not at Pressure 1");
  const depthOnly = await w.send(undefined, { path: "/depth/1" });
  assert.equal((await w.gate.charge(depthOnly, { amount: 10 ** 9, currency: "XXX" })).enforced, false, "not where the route asks no scope");
  const noMandate = await w.send(undefined);
  assert.equal((await w.gate.charge(noMandate, { amount: 1, currency: "JPY" })).error, "mandate_required");
  for (const junk of [undefined, null, {}, { cls: { class: "VERIFIED" } }, { cls: null, route: null }]) assert.equal(typeof (await w.gate.charge(junk, junk)).ok, "boolean", "never throws");
});

test("mandate: per_day is the site's — without a shared ledger it is refused, per-charge limits hold anyway (PRS-3)", async () => {
  const w = await world();
  const counted = await w.send(await mandateOf(w.registry));
  assert.deepEqual(await w.gate.charge(counted, { amount: 1, currency: "JPY" }).then((v) => [v.ok, v.error, v.reason]), [false, "mandate_scope", "no_shared_ledger"]);
  const plain = await w.send(await mandateOf(w.registry, { limits: { checkout_max: 50_000, currency: "JPY" }, jti: "mdt-bbbbbbbbbbbbbbbb" }));
  assert.deepEqual(await w.gate.charge(plain, { amount: 50_000, currency: "JPY" }), { ok: true, enforced: true, remaining: { per_day: null } }, "nothing to count");
  assert.equal((await w.gate.charge(plain, { amount: 50_001, currency: "JPY" })).reason, "over_limit");
  await assert.rejects(() => harness({ agentKeys: [], mandateLedger: { maxMandates: 5 } }), /mandateLedger must be a shared ledger/, "the old per-Gate bounds are not a ledger");
  await assert.rejects(() => gateConfig({ site_id: "s", mandate_ledger: "disk" }), /mandate_ledger must be/);
  assert.equal(typeof (await gateConfig({ site_id: "s", mandate_ledger: "memory" })).mandateLedger.charge, "function");
  assert.equal((await gateConfig({ site_id: "s", mandate_ledger: { sqlite: "ledger.db" } })).mandateLedgerFile, "ledger.db");
});

test("mandate: a Gate without Registry keys cannot read a Mandate; its fail_mode decides, as for a Staple", async () => {
  const agent = await keypair(), registry = await keypair();
  const m = await mandateOf(registry);
  for (const [failMode, action] of [["open", "allow"], ["closed", "deny"]]) {
    const gate = await harness({ agentKeys: [agent], routes: ROUTES, failMode });
    const req = await signed({ key: agent, method: "POST", url: `${SITE}/checkout/1`, headers: { "ludion-mandate": m }, extraComponents: [component("ludion-mandate")] });
    const r = await gate.inspect(req);
    assert.equal(r.cls.mandateError, "no_registry_keys"); assert.equal(r.decision.action, action, failMode);
    assert.equal((await gate.charge(r, { amount: 1, currency: "JPY" })).ok, action === "allow", failMode);
  }
});

test("mandate: the memory ledger never drops a count still inside its 24 hours", async () => {
  const ledger = memoryLedger({ maxMandates: 2 });
  const m = (jti) => ({ jti, scope: ["checkout"], limits: { checkout_max: 10, currency: "JPY", per_day: 1 } });
  assert.equal((await ledger.charge(m("a"), { at: 0 })).ok, true);
  assert.equal((await ledger.charge(m("b"), { at: 0 })).ok, true);
  assert.equal((await ledger.charge(m("c"), { at: 0 })).reason, "ledger_full", "full of live counts: refused, not let through uncounted");
  assert.equal((await ledger.charge(m("a"), { at: 0 })).reason, "per_day", "a's count survived");
  assert.equal((await ledger.charge(m("c"), { at: 86_400_001 })).ok, true, "stale counts make room");
});

test("mandate: config names only the scopes a Mandate can carry", async () => {
  await assert.rejects(() => gateConfig({ site_id: "s", routes: [{ match: "/pay", pressure: 2, require: { scope: "chekout" } }] }), /scope must be one of read, account, post, reserve, checkout, delete/);
  const ok = await gateConfig({ site_id: "s", routes: [{ match: "/pay", pressure: 2, require: { scope: "checkout" } }] });
  assert.equal(ok.routes[0].require.scope, "checkout");
});

test("passkey primitives: DER signatures, both algorithms, HMAC", async () => {
  const data = new TextEncoder().encode("authenticatorData ‖ SHA-256(clientDataJSON)");
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecJwk = await passkeyPublicJwk(new Uint8Array(await crypto.subtle.exportKey("spki", ec.publicKey)), -7);
  assert.equal(ecJwk.kty, "EC");
  for (let i = 0; i < 32; i++) { // short r / s (leading zero bytes) turn up within a few dozen signatures
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, data));
    const der = toDer(raw);
    assert.deepEqual(derToRawEcdsa(der, 32), raw);
    assert.equal(await verifyPasskeySignature(ecJwk, der, data), true);
  }
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, data));
  assert.equal(await verifyPasskeySignature(ecJwk, raw, data), false, "raw r‖s is not what WebAuthn sends");
  assert.equal(await verifyPasskeySignature(ecJwk, toDer(raw), new TextEncoder().encode("other bytes")), false);
  const der = toDer(raw);
  for (const [what, bad] of [["trailing byte", Uint8Array.from([...der, 0])], ["wrong tag", Uint8Array.from([0x31, ...der.subarray(1)])],
    ["non-minimal", nonMinimal(der)], ["negative", negative(der)], ["truncated", der.subarray(0, der.length - 1)]]) {
    assert.throws(() => derToRawEcdsa(bad, 32), /DER/, what);
  }
  const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const edJwk = await passkeyPublicJwk(new Uint8Array(await crypto.subtle.exportKey("spki", ed.publicKey)), -8);
  const edSig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, ed.privateKey, data));
  assert.equal(await verifyPasskeySignature(edJwk, edSig, data), true);
  assert.equal(await verifyPasskeySignature(edJwk, edSig, new TextEncoder().encode("x")), false);
  const edSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ed.publicKey));
  await assert.rejects(() => passkeyPublicJwk(edSpki, -7), /not a public key/);
  await assert.rejects(() => passkeyPublicJwk(new Uint8Array(8), -257), /unsupported/);
  const k = crypto.getRandomValues(new Uint8Array(32));
  assert.equal(Buffer.from(await hmacSha256(k, new TextEncoder().encode("https://shop.example"))).toString("hex"),
    createHmac("sha256", k).update("https://shop.example").digest("hex"));
});

function toDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? [0, ...b] : [...b]; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}
function nonMinimal(der) { // prefix r with a redundant 0x00
  const rl = der[3], r = der.subarray(4, 4 + rl), rest = der.subarray(4 + rl);
  return Uint8Array.from([0x30, der[1] + 1, 0x02, rl + 1, 0, ...r, ...rest]);
}
function negative(der) { // strip r's sign byte, or flip its top bit
  const rl = der[3], r = [...der.subarray(4, 4 + rl)], rest = der.subarray(4 + rl);
  if (r[0] === 0) return Uint8Array.from([0x30, der[1] - 1, 0x02, rl - 1, ...r.slice(1), ...rest]);
  r[0] |= 0x80;
  return Uint8Array.from([0x30, der[1], 0x02, rl, ...r, ...rest]);
}
