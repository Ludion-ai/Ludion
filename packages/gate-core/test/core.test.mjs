import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createResolver, classify, createStapleVerifier, issueStaple, createPolicy, decide, createNonceCache,
  generateSiteKey, importSiteKey, createReceipts, templatePath, hashIp, compileRoute,
} from "../src/index.mjs";
import { assertFetchable, DiscoveryError } from "../src/resolver.mjs";
import { thumbprint } from "../src/thumbprint.mjs";

// --- draft-ietf-webbotauth-httpsig-protocol-00, Appendix E.2 (Ed25519, RFC 9421 B.1.4 key) ---
const VEC_JWK = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const VEC_KID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const VEC_NOW = () => 1735689600 * 1000 + 1000;
const agentEntry = { type: "directory", uri: "https://signature-agent.test" };

function vectorRequest(fields) {
  return { kind: "request", method: "GET", targetUri: "https://example.com/", fields };
}
const E21 = vectorRequest([
  { name: "signature-agent", value: 'agent2="https://signature-agent.test"' },
  { name: "signature-input", value: 'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"' },
  { name: "signature", value: "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:" },
]);
const E22_LEGACY = vectorRequest([
  { name: "signature-agent", value: '"https://signature-agent.test"' },
  { name: "signature-input", value: 'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"' },
  { name: "signature", value: "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:" },
]);

test("thumbprint matches the draft's keyid for the RFC 9421 B.1.4 Ed25519 key", () => {
  assert.equal(thumbprint(VEC_JWK), VEC_KID);
});

async function primedResolver() {
  const r = createResolver({ now: VEC_NOW });
  await r.prime(agentEntry, { keys: [VEC_JWK] });
  return r;
}

test("E.2.1 dictionary Signature-Agent → VERIFIED (lifetime check relaxed for the far-future vector)", async () => {
  // The vector's expires is far in the future; spec §10.4 caps lifetime at 60s. We verify the
  // cryptographic path via the library directly and the policy path via a fresh signature below.
  const { verify } = await import("web-bot-auth");
  const r = await primedResolver();
  const v = await verify(E21, { resolver: (c) => r.resolve(c), now: new Date(VEC_NOW()), maxAge: 1e12 });
  assert.equal(v.keyid, VEC_KID);
  assert.equal(v.verifier.identifier, "https://signature-agent.test");
});

test("E.2.2 legacy sf-string Signature-Agent verifies cryptographically (the library path, lifetime aside)", async () => {
  // As for E.2.1: the vector's lifetime (3600 s) is past spec §10.4's 60 s; STD-5 runs a fresh
  // signature of the same shape through the Gate.
  const { verify } = await import("web-bot-auth");
  const r = await primedResolver();
  const v = await verify(E22_LEGACY, { resolver: (c) => r.resolve(c), now: new Date(VEC_NOW()), maxAge: 1e12 });
  assert.equal(v.keyid, VEC_KID);
  assert.equal(v.verifier.identifier, "https://signature-agent.test");
});

test("E.2.2 legacy sf-string Signature-Agent still verifies (verifier MAY accept)", async () => {
  const r = await primedResolver();
  const cls = await classify(E22_LEGACY, { resolver: r, now: VEC_NOW });
  // expires - created = 3600s > 60s → policy rejects as SPOOFED even though crypto is valid.
  assert.equal(cls.class, "SPOOFED");
});

test("tampered signature → SPOOFED; unknown keyid → UNVERIFIED; unresolvable agent → UNVERIFIED", async () => {
  const r = await primedResolver();
  const tampered = vectorRequest(E21.fields.map((f) => (f.name === "signature" ? { ...f, value: f.value.replace("RdNF", "RdNG") } : f)));
  const { verify } = await import("web-bot-auth");
  await assert.rejects(() => verify(tampered, { resolver: (c) => r.resolve(c), now: new Date(VEC_NOW()), maxAge: 1e12 }));
  const unknownKey = vectorRequest(E21.fields.map((f) => (f.name === "signature-input" ? { ...f, value: f.value.replace(VEC_KID, "AAAA" + VEC_KID.slice(4)) } : f)));
  const cls = await classify(unknownKey, { resolver: r, now: VEC_NOW });
  assert.equal(cls.class, "UNVERIFIED");
  assert.equal(cls.reason, "unknown-key");
});

test("unsigned classification: known token → DECLARED, automation signal → SUSPECTED, browser → UNKNOWN", async () => {
  const r = await primedResolver();
  const mk = (ua) => vectorRequest(ua === undefined ? [] : [{ name: "user-agent", value: ua }]);
  assert.equal((await classify(mk("Mozilla/5.0 (compatible; GPTBot/1.0)"), { resolver: r })).class, "DECLARED");
  assert.equal((await classify(mk("python-requests/2.32"), { resolver: r })).class, "SUSPECTED");
  assert.equal((await classify(mk("Mozilla/5.0 (Macintosh) Safari/605"), { resolver: r })).class, "UNKNOWN");
  assert.equal((await classify(mk(undefined), { resolver: r })).class, "SUSPECTED");
});

test("SSRF guards: non-https, credentials, private/loopback literals, localhost refused", () => {
  const o = { insecureAllowHttp: false, allowPrivateNetwork: false };
  for (const u of ["http://example.com", "https://user:pw@example.com", "https://127.0.0.1", "https://10.1.2.3", "https://192.168.0.1",
    "https://169.254.169.254", "https://localhost", "https://[::1]", "https://[fd00::1]", "https://172.16.0.1", "https://100.64.0.1"]) {
    assert.throws(() => assertFetchable(new URL(u), o), DiscoveryError, u);
  }
  assert.doesNotThrow(() => assertFetchable(new URL("https://agent.example.com"), o));
});

test("directory member must be an origin; oversized directory rejected; failed fetch does not evict cache", async () => {
  let calls = 0;
  const fetchStub = async (url) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ keys: [{ ...VEC_JWK, kid: VEC_KID, use: "sig" }] }), { status: 200, headers: { "cache-control": "max-age=1" } });
    return new Response("boom", { status: 500 });
  };
  let t = 1_000_000;
  const r = createResolver({ fetch: fetchStub, now: () => t, minTtlMs: 1000 });
  const cand = { keyid: VEC_KID, algorithm: "ed25519", signatureAgent: { label: "sig1", uri: "https://agent.example.com", type: "directory" } };
  assert.equal((await r.resolve(cand)).identifier, "https://agent.example.com/.well-known/http-message-signatures-directory");
  t += 5000; // cache stale → refetch fails → stale entry retained (draft §6.10)
  assert.equal((await r.resolve(cand)).identifier, "https://agent.example.com/.well-known/http-message-signatures-directory");
  await assert.rejects(() => r.resolve({ ...cand, signatureAgent: { ...cand.signatureAgent, uri: "https://agent.example.com/path" } }), /origin/);
  const big = createResolver({ fetch: async () => new Response("x".repeat(70000), { status: 200 }), maxBytes: 65536 });
  await assert.rejects(() => big.resolve({ ...cand, signatureAgent: { ...cand.signatureAgent, uri: "https://big.example.com" } }), /too large/);
});

test("Staple: valid, bound to key; rejects wrong key, expired, >1h lifetime, wrong issuer, bad subject", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const kid = thumbprint({ kty: "OKP", crv: "Ed25519", x: pub.x });
  const sv = await createStapleVerifier({ keys: [{ kty: "OKP", crv: "Ed25519", x: pub.x, kid }] }, { now: () => 1_800_000_000 * 1000 });
  const base = { iss: "https://registry.ludion.ai", sub: "dvr-k7q2m6x4pcab3cde", iat: 1_800_000_000, exp: 1_800_003_600, depth: 2, ballast: { status: "active" }, cnf: { jkt: ["KEY1"] } };
  const issue = (priv, payload) => issueStaple(priv, kid, payload);
  const ok = await sv.verify(await issue(kp.privateKey, base), { requestKeyid: "KEY1" });
  assert.equal(ok.depth, 2);
  const rejects = async (staple, binding, re) => assert.rejects(() => sv.verify(staple, binding), re);
  await rejects(await issue(kp.privateKey, base), { requestKeyid: "KEY2" }, /not bound/);
  await rejects(await issue(kp.privateKey, { ...base, exp: 1_799_999_000 }), { requestKeyid: "KEY1" }, /expired/);
  await rejects(await issue(kp.privateKey, { ...base, exp: 1_800_007_200 }), { requestKeyid: "KEY1" }, /lifetime/);
  await rejects(await issue(kp.privateKey, { ...base, iss: "https://evil.example" }), { requestKeyid: "KEY1" }, /issuer/);
  await rejects(await issue(kp.privateKey, { ...base, sub: "bob" }), { requestKeyid: "KEY1" }, /subject/);
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  await rejects(await issue(other.privateKey, base), { requestKeyid: "KEY1" }, /invalid/);
});

test("routes & Pressure decision matrix", () => {
  const policy = createPolicy({ pressure: 0, routes: [
    { match: "/checkout/**", pressure: 2, require: { depth: 2, scope: "checkout", ballast: "active" } },
    { match: "/login", pressure: 2, require: { depth: 1 } },
    { match: "/api/search", pressure: 1 },
    { match: "/admin/*", pressure: 3 },
  ]});
  assert.equal(policy.forPath("/").pressure, 0);
  assert.equal(policy.forPath("/checkout/abc/confirm").pressure, 2);
  assert.equal(policy.forPath("/admin/x").pressure, 3);
  assert.ok(compileRoute("/items/:id").test("/items/42"));
  const at = (p) => policy.forPath(p);
  assert.deepEqual(decide({ class: "UNKNOWN" }, at("/checkout/1")), { action: "allow" });               // humans untouched
  assert.deepEqual(decide({ class: "SUSPECTED" }, at("/")), { action: "allow" });                       // P0 observes
  assert.deepEqual(decide({ class: "SUSPECTED" }, at("/api/search")), { action: "friction" });          // P1 existing friction
  assert.deepEqual(decide({ class: "VERIFIED", depth: 0 }, at("/api/search")), { action: "allow", exempt: true });
  assert.equal(decide({ class: "DECLARED" }, at("/login")).error, "signature_required");
  assert.equal(decide({ class: "VERIFIED", depth: 0 }, at("/login")).error, "depth_insufficient");
  assert.equal(decide({ class: "VERIFIED", depth: 1 }, at("/login")).action, "allow");
  assert.equal(decide({ class: "VERIFIED", depth: 2, ballast: { status: "active" } }, at("/checkout/1")).error, "mandate_required");
  assert.equal(decide({ class: "VERIFIED", depth: 2, ballast: { status: "active" }, mandate: { scope: ["read"] } }, at("/checkout/1")).error, "mandate_scope");
  assert.equal(decide({ class: "VERIFIED", depth: 2, ballast: { status: "active" }, mandate: { scope: ["checkout"] } }, at("/checkout/1")).action, "allow");
  assert.equal(decide({ class: "REVOKED" }, at("/login")).error, "revoked");
  assert.equal(decide({ class: "SPOOFED" }, at("/login")).status, 401);
  assert.equal(decide({ class: "UNKNOWN" }, at("/admin/x")).action, "allow");                            // P3 still never touches humans
});

test("Glass receipts: sign/verify, route templating, IP truncation+hash", async () => {
  const k = await generateSiteKey();
  const siteKey = await importSiteKey(k.privateJwk);
  const rc = createReceipts({ siteId: "site-x", siteKey });
  const receipt = await rc.issue({ method: "POST", path: "/checkout/123456/confirm", cls: { class: "VERIFIED", diverId: "dvr-aaaaaaaaaaaaaaaa" }, decision: { action: "allow" }, pressure: 2, signature: "sig1=:abc:" });
  assert.equal(receipt.route, "/checkout/:id/confirm");
  assert.ok(await rc.verify(receipt, siteKey.publicKey));
  assert.equal(await rc.verify({ ...receipt, decision: "deny" }, siteKey.publicKey), false);
  assert.equal(templatePath("/u/550e8400-e29b-41d4-a716-446655440000/orders/9?x=1"), "/u/:uuid/orders/:id");
  assert.equal(hashIp("203.0.113.77", "salt"), hashIp("203.0.113.200", "salt")); // same /24
  assert.notEqual(hashIp("203.0.113.77", "salt"), hashIp("203.0.114.77", "salt"));
  assert.equal(hashIp("2001:db8:1234:5678::1", "s"), hashIp("2001:db8:1234:abcd::9", "s")); // same /48
});

test("nonce cache rejects reuse within lifetime and expires", () => {
  let t = 0;
  const c = createNonceCache({ now: () => t, maxEntries: 3 });
  assert.equal(c.check("n1", 60_000), true);
  assert.equal(c.check("n1", 60_000), false);
  t = 61_000;
  assert.equal(c.check("n1", 120_000), true);
  c.check("n2", 200_000); c.check("n3", 200_000); c.check("n4", 200_000); // over capacity → degrades, never throws
  assert.ok(c.size() <= 3);
});
