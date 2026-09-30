// The portable suite (NEUT-1): the same file runs unmodified on Node, Deno and workerd.
// It imports only the published packages (@ludion/gate-core, @ludion/card-host) and the audited
// signing libraries, uses only Web APIs (crypto.subtle, fetch types, TextEncoder), injects time
// and key discovery, and touches no network, file system or environment.
import { test, assert } from "./shim.mjs";
import {
  createGate, createResolver, classify, createPolicy, decide, createStapleVerifier, issueStaple,
  generateSiteKey, importSiteKey, createReceipts, templatePath,
} from "@ludion/gate-core";
import { createCardHost, DIRECTORY_PATH, DIRECTORY_MEDIA_TYPE, CARD_PATH } from "@ludion/card-host";
import { verify, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { createSignature, component } from "http-message-sig";

// ── draft-ietf-webbotauth-httpsig-protocol-00, Appendix E.2 (Ed25519, the RFC 9421 B.1.4 key) ──
const VEC_JWK = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const VEC_KID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const VEC_NOW = 1735689600 * 1000 + 1000;
const E21 = { kind: "request", method: "GET", targetUri: "https://example.com/", fields: [
  { name: "signature-agent", value: 'agent2="https://signature-agent.test"' },
  { name: "signature-input", value: 'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"' },
  { name: "signature", value: "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:" },
] };

// ── a world: one agent, one Registry, one site at Pressure 0 with critical routes at 2 ──────────
const NOW_MS = 1_800_000_000_000, NOW_S = NOW_MS / 1000;
const AGENT = "https://agent.example", SITE = "https://shop.example", ISS = "https://registry.ludion.ai";
const ROUTES = [{ match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2, require: { depth: 1 } }];
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey), priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const kid = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: pub.x }))));
  return { kid, publicJwk: { kty: "OKP", crv: "Ed25519", x: pub.x, kid }, privateJwk: { kty: "OKP", crv: "Ed25519", x: pub.x, d: priv.d }, privateKey: kp.privateKey };
}

async function signed(key, { url = `${SITE}/checkout/1`, ua = "ExampleAgent/1.0", staple, keyid = key.kid } = {}) {
  const headers = { "user-agent": ua, "signature-agent": `sig1="${AGENT}"`, ...(staple ? { "ludion-staple": staple } : {}) };
  const req = { kind: "request", method: "GET", targetUri: url, fields: Object.entries(headers).map(([name, value]) => ({ name, value })) };
  const out = await createSignature(req, {
    label: "sig1", signer: await signerFromJWK(key.privateJwk),
    components: ["@authority", component("signature-agent", { key: "sig1" }), ...(staple ? ["ludion-staple"] : [])],
    parameters: { created: NOW_S, expires: NOW_S + 60, keyid, alg: "ed25519", nonce: generateNonce(), tag: "web-bot-auth" },
  });
  req.fields.push({ name: "signature-input", value: out.signatureInput }, { name: "signature", value: out.signature });
  return req;
}
const unsigned = (ua, url = `${SITE}/checkout/1`) => ({ kind: "request", method: "GET", targetUri: url, fields: ua ? [{ name: "user-agent", value: ua }] : [] });
const withField = (req, name, value) => ({ ...req, fields: req.fields.map((f) => (f.name === name ? { ...f, value } : f)) });

let world;
async function theWorld() {
  if (world) return world;
  const [agent, registry, stranger] = await Promise.all([keypair(), keypair(), keypair()]);
  const siteKey = await generateSiteKey();
  const gate = await createGate({
    siteId: "site-portable", siteKey: siteKey.privateJwk, pressure: 0, routes: ROUTES, now: () => NOW_MS,
    authorities: [new URL(SITE).host], registryKeys: { keys: [registry.publicJwk] }, registryIssuer: ISS,
  });
  await gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  world = { agent, registry, stranger, siteKey, gate };
  return world;
}
const stapleFor = (w, over = {}) => issueStaple(w.registry.privateKey, w.registry.kid,
  { iss: ISS, sub: "dvr-portableportable", iat: NOW_S, exp: NOW_S + 3600, depth: 2, ballast: { status: "active" }, cnf: { jkt: [w.agent.kid] }, ...over });

// ── standards ────────────────────────────────────────────────────────────────────────────────
test("WG App. E.2.1 vector verifies (keyid and directory identifier)", async () => {
  const r = createResolver({ now: () => VEC_NOW });
  await r.prime({ type: "directory", uri: "https://signature-agent.test" }, { keys: [VEC_JWK] });
  const v = await verify(E21, { resolver: (c) => r.resolve(c), now: new Date(VEC_NOW), maxAge: 1e12 });
  assert.equal(v.keyid, VEC_KID);
  assert.equal(v.verifier.identifier, "https://signature-agent.test");
});

test("WG App. E.2.1 vector with one flipped signature byte is rejected", async () => {
  const r = createResolver({ now: () => VEC_NOW });
  await r.prime({ type: "directory", uri: "https://signature-agent.test" }, { keys: [VEC_JWK] });
  const tampered = withField(E21, "signature", E21.fields[2].value.replace("RdNF", "RdNG"));
  await assert.rejects(() => verify(tampered, { resolver: (c) => r.resolve(c), now: new Date(VEC_NOW), maxAge: 1e12 }));
});

// ── classification through the Gate ──────────────────────────────────────────────────────────
test("a fresh Web Bot Auth signature is VERIFIED with the agent's identifier", async () => {
  const w = await theWorld();
  const { cls, decision } = await w.gate.inspect(await signed(w.agent, { url: `${SITE}/products` }));
  assert.equal(cls.class, "VERIFIED");
  assert.match(cls.identifier, /^https:\/\/agent\.example/);
  assert.equal(decision.action, "allow");
});

test("a tampered signature is SPOOFED and denied on a Pressure 2 route", async () => {
  const w = await theWorld();
  const req = await signed(w.agent);
  const sig = req.fields.find((f) => f.name === "signature").value;
  const flipped = sig.replace(/:(.)/, (_, c) => `:${c === "A" ? "B" : "A"}`);
  const { cls, decision } = await w.gate.inspect(withField(req, "signature", flipped));
  assert.equal(cls.class, "SPOOFED");
  assert.equal(decision.action, "deny");
});

test("a key the agent's directory does not list is UNVERIFIED", async () => {
  const w = await theWorld();
  const { cls } = await w.gate.inspect(await signed(w.stranger, { url: `${SITE}/products` }));
  assert.equal(cls.class, "UNVERIFIED");
});

test("unsigned: a declared crawler is DECLARED, a script is SUSPECTED, a browser is UNKNOWN", async () => {
  const w = await theWorld();
  assert.equal((await w.gate.inspect(unsigned("Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)", `${SITE}/`))).cls.class, "DECLARED");
  assert.equal((await w.gate.inspect(unsigned("python-requests/2.32.3", `${SITE}/`))).cls.class, "SUSPECTED");
  assert.equal((await w.gate.inspect(unsigned("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", `${SITE}/`))).cls.class, "UNKNOWN");
});

test("a replayed signature (same nonce) is refused the second time", async () => {
  const w = await theWorld();
  const req = await signed(w.agent, { url: `${SITE}/products/replay` });
  assert.equal((await w.gate.inspect(req)).cls.class, "VERIFIED");
  assert.notEqual((await w.gate.inspect(req)).cls.class, "VERIFIED");
});

test("humans are untouched at every Pressure; a declared bot is asked to sign on a Pressure 2 route", async () => {
  const w = await theWorld();
  const human = await w.gate.inspect(unsigned("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"));
  assert.equal(human.decision.action, "allow");
  const bot = await w.gate.inspect(unsigned("Mozilla/5.0 (compatible; GPTBot/1.0)"));
  assert.equal(bot.decision.action, "deny");
  assert.equal(bot.decision.error, "signature_required");
  assert.equal(bot.headers["Ludion-Error"], "signature_required");
  assert.match(bot.headers.Link ?? "", /rel="help"/);
  assert.match(bot.headers["Accept-Signature"] ?? "", /tag="web-bot-auth"/);
});

// ── Staples ──────────────────────────────────────────────────────────────────────────────────
test("Staple: a covered, bound Staple gives the request its Depth; a Staple bound to another key does not", async () => {
  const w = await theWorld();
  const ok = await w.gate.inspect(await signed(w.agent, { url: `${SITE}/login`, staple: await stapleFor(w) }));
  assert.equal(ok.cls.class, "VERIFIED");
  assert.equal(ok.cls.depth, 2);
  assert.equal(ok.decision.action, "allow");
  const misbound = await w.gate.inspect(await signed(w.agent, { url: `${SITE}/login`, staple: await stapleFor(w, { cnf: { jkt: ["someone-else"] } }) }));
  assert.ok(misbound.cls.class !== "VERIFIED" || !(misbound.cls.depth > 0), `misbound Staple gave standing: ${misbound.cls.class} depth ${misbound.cls.depth}`);
  assert.equal(misbound.decision.action, "deny");
});

test("Staple verifier: valid; rejects wrong key binding, expired, over one hour, wrong issuer, foreign signer", async () => {
  const w = await theWorld();
  const sv = await createStapleVerifier({ keys: [w.registry.publicJwk] }, { issuer: ISS, now: () => NOW_MS });
  const ok = await sv.verify(await stapleFor(w), { requestKeyid: w.agent.kid });
  assert.equal(ok.depth, 2);
  await assert.rejects(async () => sv.verify(await stapleFor(w), { requestKeyid: "another-key" }), /not bound/);
  // Past the verifier's 30 s clock-skew allowance (staple.mjs clockSkewS).
  await assert.rejects(async () => sv.verify(await stapleFor(w, { iat: NOW_S - 3000, exp: NOW_S - 31 }), { requestKeyid: w.agent.kid }), /expired/);
  await assert.rejects(async () => sv.verify(await stapleFor(w, { exp: NOW_S + 7200 }), { requestKeyid: w.agent.kid }), /lifetime/);
  await assert.rejects(async () => sv.verify(await stapleFor(w, { iss: "https://evil.example" }), { requestKeyid: w.agent.kid }), /issuer/);
  const foreign = await issueStaple(w.stranger.privateKey, w.registry.kid, { iss: ISS, sub: "dvr-portableportable", iat: NOW_S, exp: NOW_S + 3600, depth: 2, cnf: { jkt: [w.agent.kid] } });
  await assert.rejects(async () => sv.verify(foreign, { requestKeyid: w.agent.kid }), /invalid/);
});

// ── decide() ─────────────────────────────────────────────────────────────────────────────────
test("decide(): the Pressure matrix", () => {
  const policy = createPolicy({ pressure: 0, routes: [
    { match: "/checkout/**", pressure: 2, require: { depth: 2, scope: "checkout", ballast: "active" } },
    { match: "/login", pressure: 2, require: { depth: 1 } }, { match: "/api/search", pressure: 1 }, { match: "/admin/*", pressure: 3 },
  ] });
  const at = (p) => policy.forPath(p);
  assert.deepEqual(decide({ class: "UNKNOWN" }, at("/admin/x")), { action: "allow" });
  assert.deepEqual(decide({ class: "SUSPECTED" }, at("/")), { action: "allow" });
  assert.deepEqual(decide({ class: "SUSPECTED" }, at("/api/search")), { action: "friction" });
  assert.equal(decide({ class: "DECLARED" }, at("/login")).error, "signature_required");
  assert.equal(decide({ class: "VERIFIED", depth: 0 }, at("/login")).error, "depth_insufficient");
  assert.equal(decide({ class: "VERIFIED", depth: 1 }, at("/login")).action, "allow");
  assert.equal(decide({ class: "VERIFIED", depth: 2, ballast: { status: "active" } }, at("/checkout/1")).error, "mandate_required");
  assert.equal(decide({ class: "VERIFIED", depth: 2, ballast: { status: "active" }, mandate: { scope: ["checkout"] } }, at("/checkout/1")).action, "allow");
  assert.equal(decide({ class: "REVOKED" }, at("/login")).error, "revoked");
  assert.equal(decide({ class: "SPOOFED" }, at("/login")).status, 401);
});

// ── Glass receipts ───────────────────────────────────────────────────────────────────────────
test("Glass receipts: the Gate's receipt verifies with the site key; a changed decision does not", async () => {
  const w = await theWorld();
  const siteKey = await importSiteKey(w.siteKey.privateJwk);
  const rc = createReceipts({ siteId: "site-portable", siteKey, now: () => NOW_MS });
  const { receipt } = await w.gate.inspect(await signed(w.agent, { url: `${SITE}/products/7` }));
  assert.ok(await rc.verify(receipt, siteKey.publicKey), "the Gate's receipt verifies");
  assert.equal(await rc.verify({ ...receipt, decision: receipt.decision === "deny" ? "allow" : "deny" }, siteKey.publicKey), false);
  const mine = await rc.issue({ method: "POST", path: "/checkout/123456/confirm", cls: { class: "VERIFIED" }, decision: { action: "allow" }, pressure: 2, signature: "sig1=:abc:" });
  assert.equal(mine.route, "/checkout/:id/confirm");
  assert.ok(await rc.verify(mine, siteKey.publicKey));
  assert.equal(templatePath("/u/550e8400-e29b-41d4-a716-446655440000/orders/9?x=1"), "/u/:uuid/orders/:id");
});

// ── Card Host ────────────────────────────────────────────────────────────────────────────────
test("Card Host: directory with its media type, the Card at its own URL, public members only, 404 otherwise", async () => {
  const w = await theWorld();
  const host = "dvr-portableportable.agents.ludion.ai";
  const card = { client_id: `https://${host}${CARD_PATH}`, client_name: "Portable Agent", jwks_uri: `https://${host}${DIRECTORY_PATH}` };
  const ch = createCardHost({ lookup: (h) => (h === host ? { directory: { keys: [{ ...w.agent.privateJwk, kid: w.agent.kid }] }, card } : undefined) });
  const dir = await ch.fetch(new Request(`https://${host}${DIRECTORY_PATH}`));
  assert.equal(dir.status, 200);
  assert.equal(dir.headers.get("content-type"), DIRECTORY_MEDIA_TYPE);
  const keys = (await dir.json()).keys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].x, w.agent.publicJwk.x);
  assert.equal(keys[0].d, undefined, "the private member is never served");
  const c = await ch.fetch(new Request(`https://${host}${CARD_PATH}`));
  assert.equal(c.status, 200);
  assert.match(c.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal((await c.json()).client_id, card.client_id);
  assert.equal((await ch.fetch(new Request(`https://unknown.agents.ludion.ai${DIRECTORY_PATH}`))).status, 404);
  assert.equal((await ch.fetch(new Request(`https://${host}/admin`))).status, 404);
  assert.equal((await ch.fetch(new Request(`https://${host}${CARD_PATH}`, { method: "POST" }))).status, 405);
});

test("classify() alone, with a primed resolver and no Gate around it", async () => {
  const w = await theWorld();
  const r = createResolver({ now: () => NOW_MS });
  await r.prime({ type: "directory", uri: AGENT }, { keys: [{ ...w.agent.publicJwk, use: "sig" }] });
  const cls = await classify(await signed(w.agent, { url: `${SITE}/products/9` }), { resolver: r, now: () => NOW_MS });
  assert.equal(cls.class, "VERIFIED");
});
