// Registry v0 API (spec §13.2): registration, key approval, Staples, revocation, the stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistryClient, signRootStatement, generateEd25519 } from "@ludion/diver";
import { createStapleVerifier } from "@ludion/gate-core";
import { REVOCATION_TYP } from "@ludion/gate-core/revocation";
import { diverStore, registryWorld, REGISTRY_ORIGIN } from "./support.mjs";

const post = (fetch, path, body, headers = { "content-type": "application/json" }) =>
  fetch(`${REGISTRY_ORIGIN}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function registered(w, opts = {}) {
  const d = await diverStore();
  const client = createRegistryClient({ url: REGISTRY_ORIGIN, fetch: w.fetch });
  await client.register(d.store, d.root, opts);
  await client.approveKeys(d.store, d.root, [d.session]);
  return { ...d, client };
}

test("registry: registration is Root-signed, idempotent, and bound to the diver_id", async () => {
  const w = await registryWorld();
  const d = await diverStore();
  const client = createRegistryClient({ url: REGISTRY_ORIGIN, fetch: w.fetch });
  assert.equal((await client.register(d.store, d.root)).diver_id, d.store.diver_id);
  assert.equal((await client.register(d.store, d.root)).status, "active");
  const other = await generateEd25519();
  const forged = signRootStatement(other.privateJwk, "ludion-register+jwt", { sub: d.store.diver_id, root: { kty: "OKP", crv: "Ed25519", x: d.root.x }, signature_agent: d.store.signature_agent, iat: Math.floor(Date.now() / 1000) });
  assert.equal((await post(w.fetch, "/v0/divers", { statement: forged })).status, 401, "signed by another key");
  const wrongSub = signRootStatement(d.root, "ludion-register+jwt", { sub: "dvr-aaaaaaaaaaaaaaaa", root: { kty: "OKP", crv: "Ed25519", x: d.root.x }, signature_agent: d.store.signature_agent, iat: Math.floor(Date.now() / 1000) });
  assert.equal((await post(w.fetch, "/v0/divers", { statement: wrongSub })).status, 400, "sub must be the Root's diver_id");
  const stale = signRootStatement(d.root, "ludion-register+jwt", { sub: d.store.diver_id, root: { kty: "OKP", crv: "Ed25519", x: d.root.x }, signature_agent: d.store.signature_agent, iat: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await post(w.fetch, "/v0/divers", { statement: stale })).status, 400, "a captured statement cannot be replayed later");
  const httpAgent = signRootStatement(d.root, "ludion-register+jwt", { sub: d.store.diver_id, root: { kty: "OKP", crv: "Ed25519", x: d.root.x }, signature_agent: "http://plain.example", iat: Math.floor(Date.now() / 1000) + 1 });
  assert.equal((await post(w.fetch, "/v0/divers", { statement: httpAgent })).status, 400);
});

test("registry: key approval never admits the Root, a private key, or an older approval", async () => {
  const w = await registryWorld();
  const d = await diverStore();
  const client = createRegistryClient({ url: REGISTRY_ORIGIN, fetch: w.fetch });
  await client.register(d.store, d.root);
  await assert.rejects(client.approveKeys(d.store, d.root, [d.root]), /root_is_not_a_session_key/);
  const withD = signRootStatement(d.root, "ludion-keys+jwt", { sub: d.store.diver_id, keys: [d.session], iat: Math.floor(Date.now() / 1000) });
  assert.equal((await post(w.fetch, `/v0/divers/${d.store.diver_id}/keys`, { statement: withD })).status, 400, "a JWK with d is refused");
  const t = Math.floor(Date.now() / 1000);
  const newer = signRootStatement(d.root, "ludion-keys+jwt", { sub: d.store.diver_id, keys: [{ kty: "OKP", crv: "Ed25519", x: d.session.x }], iat: t });
  const older = signRootStatement(d.root, "ludion-keys+jwt", { sub: d.store.diver_id, keys: [{ kty: "OKP", crv: "Ed25519", x: d.session.x }], iat: t - 10 });
  assert.equal((await post(w.fetch, `/v0/divers/${d.store.diver_id}/keys`, { statement: newer })).status, 200);
  assert.equal((await post(w.fetch, `/v0/divers/${d.store.diver_id}/keys`, { statement: older })).status, 409, "an older approval replayed cannot roll the key set back");
  const stranger = await generateEd25519();
  const byStranger = signRootStatement(stranger.privateJwk, "ludion-keys+jwt", { sub: d.store.diver_id, keys: [stranger.publicJwk], iat: t + 1 });
  assert.equal((await post(w.fetch, `/v0/divers/${d.store.diver_id}/keys`, { statement: byStranger })).status, 401);
});

test("registry: a Staple is short-lived, bound to the asking key, and verifies at a Gate with pinned keys", async () => {
  const w = await registryWorld();
  const d = await registered(w);
  const s = await d.client.staple(d.store, d.session);
  assert.equal(s.exp - s.iat, 3600, "at most one hour (spec §10.5)");
  const keys = await (await w.fetch(`${REGISTRY_ORIGIN}/.well-known/ludion-keys`)).json();
  assert.ok(keys.keys.every((k) => !("d" in k)));
  const v = await createStapleVerifier(keys);
  const p = await v.verify(s.staple, { requestKeyid: d.session.kid });
  assert.equal(p.sub, d.store.diver_id);
  assert.deepEqual(p.cnf.jkt, [d.session.kid]);
  assert.equal(p.ballast.status, "active", "Ballast v0 commitments made at registration");
  assert.equal(p.depth, 0, "no confirmed contact yet: D0");
  await assert.rejects(v.verify(s.staple, { requestKeyid: "someone-else" }), /not bound/);
  await w.registry.confirmContact(d.store.diver_id);
  assert.equal((await v.verify((await d.client.staple(d.store, d.session)).staple, { requestKeyid: d.session.kid })).depth, 1, "D1 once the contact is confirmed");
});

test("registry: a Staple request must be signed by an approved key, for this Registry, over this body", async () => {
  const w = await registryWorld();
  const d = await registered(w);
  const stranger = await generateEd25519();
  await assert.rejects(d.client.staple(d.store, stranger.privateJwk), /invalid_signature/, "unapproved key");
  // A body swapped under a valid signature
  const { createDiverSigner } = await import("@ludion/diver");
  const signer = await createDiverSigner({ sessionPrivateJwk: d.session, signatureAgent: d.store.signature_agent });
  const url = `${REGISTRY_ORIGIN}/v0/divers/${d.store.diver_id}/staple`;
  const h = await signer.headersFor({ method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify({ jkt: [d.session.kid] }) });
  assert.equal((await w.fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jkt: [d.session.kid, "x"] }) })).status, 401, "content-digest must match the body");
  // Signed for another authority
  const other = `https://registry.elsewhere/v0/divers/${d.store.diver_id}/staple`;
  const h2 = await signer.headersFor({ method: "POST", url: other, headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await w.fetch(other, { method: "POST", headers: h2, body: "{}" })).status, 401, "signed for another Registry");
  // No signature at all
  assert.equal((await post(w.fetch, `/v0/divers/${d.store.diver_id}/staple`, "{}")).status, 401);
  // Binding to a key that is not approved, or leaving out the asking key
  await assert.rejects(d.client.staple(d.store, d.session, { jkt: [d.session.kid, stranger.kid] }), /bad_cnf/);
  const second = await generateEd25519();
  await d.client.approveKeys(d.store, d.root, [d.session, second.privateJwk]);
  await assert.rejects(d.client.staple(d.store, d.session, { jkt: [second.kid] }), /bad_cnf/);
  assert.deepEqual((await createStapleVerifier(w.registry.publicKeys)).kids.length, 1);
});

test("registry: revocation is Root-signed, published as Registry-signed entries, and revoked Divers get revoked Staples", async () => {
  const w = await registryWorld();
  const d = await registered(w);
  const e = await registered(w);
  const r = await d.client.revoke(d.store, d.root, { reason: "compromised" });
  assert.equal(r.scope, "diver");
  const list = await (await w.fetch(`${REGISTRY_ORIGIN}/v0/revocations?since=0`)).json();
  assert.equal(list.entries.length, 1);
  const v = await createStapleVerifier(w.registry.publicKeys);
  const entry = await v.verifyStatement(list.entries[0], { typ: REVOCATION_TYP });
  assert.equal(entry.sub, d.store.diver_id);
  assert.deepEqual(entry.jkt, [d.session.kid]);
  assert.equal(entry.agent, d.store.signature_agent);
  await assert.rejects(v.verify(list.entries[0], { requestKeyid: d.session.kid }), /not a staple/, "a revocation entry never passes as a Staple");
  const s = await d.client.staple(d.store, d.session);
  assert.equal(s.revoked, true);
  assert.equal((await v.verify(s.staple, { requestKeyid: d.session.kid })).revoked, true);
  await assert.rejects(d.client.approveKeys(d.store, d.root, [d.session]), /revoked/);
  await assert.rejects(d.client.register(d.store, d.root), /revoked/);
  assert.equal((await d.client.revoke(d.store, d.root)).seq, r.seq, "revoking twice is one entry");
  assert.equal((await e.client.staple(e.store, e.session)).revoked, false, "others are untouched");
  const other = await generateEd25519();
  const byOther = signRootStatement(other.privateJwk, "ludion-revoke+jwt", { sub: e.store.diver_id, scope: "diver", reason: "compromised", iat: Math.floor(Date.now() / 1000) });
  assert.equal((await post(w.fetch, "/v0/revocations", { statement: byOther })).status, 401, "only the Diver's Root revokes it");
});

test("registry: revoking some session keys leaves the Diver and its other keys standing", async () => {
  const w = await registryWorld();
  const d = await registered(w);
  const next = await generateEd25519();
  await d.client.approveKeys(d.store, d.root, [d.session, next.privateJwk]);
  await d.client.revoke(d.store, d.root, { jkt: [d.session.kid] });
  await assert.rejects(d.client.staple(d.store, d.session), /invalid_signature/, "a revoked key is no longer approved");
  assert.equal((await d.client.staple(d.store, next.privateJwk)).revoked, false);
  await assert.rejects(d.client.approveKeys(d.store, d.root, [d.session]), /key_revoked/);
});

test("registry: the revocation stream replays the backlog, then goes live, and resumes from Last-Event-ID", async () => {
  const w = await registryWorld({ heartbeatMs: 60_000, sseRetryMs: 1234 });
  const a = await registered(w), b = await registered(w), c = await registered(w);
  await a.client.revoke(a.store, a.root);
  const res = await w.fetch(`${REGISTRY_ORIGIN}/v0/revocations/stream`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = async (re) => { while (!re.test(text)) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } };
  await until(/id: 1\n/);
  assert.match(text, /^retry: 1234\n\n/);
  await b.client.revoke(b.store, b.root);
  await until(/id: 2\n/);
  await reader.cancel();
  await c.client.revoke(c.store, c.root);
  const resumed = await w.fetch(`${REGISTRY_ORIGIN}/v0/revocations/stream`, { headers: { "last-event-id": "2" } });
  const r2 = resumed.body.getReader();
  let t2 = "";
  while (!/id: 3\n/.test(t2)) { const { value } = await r2.read(); t2 += dec.decode(value); }
  assert.doesNotMatch(t2, /id: [12]\n/, "only what came after Last-Event-ID");
  await r2.cancel();
  w.registry.close();
});
