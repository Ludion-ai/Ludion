// STD-5 (+, pair STD-2): the WG's own vector shape passes the real Gate when it is fresh. The
// draft-ietf-webbotauth-httpsig-protocol-00 App. E.2 vectors carry lifetimes no Gate may accept
// (spec §10.4: 60 s), so STD-1 checks them as cryptography only. Here the same key (RFC 9421
// B.1.4 test-key-ed25519, published with its private half), the same Signature-Agent forms
// (E.2.1 dictionary, E.2.2 legacy string), labels, covered components and tag are signed again
// with created = now and a 60 s lifetime, and go through the Gate itself: gate.inspect(), and the
// real gate-node adapter over HTTP. Each must be VERIFIED as the vector's keyid at the vector's
// directory. The same signature past the Gate's cap (an hour; 60 s without a nonce) is STD-2's to refuse.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSignature, component } from "http-message-sig";
import { signerFromJWK } from "web-bot-auth/crypto";
import { generateNonce } from "web-bot-auth";
import { createGate, generateSiteKey } from "../src/index.mjs";
import { thumbprint } from "../src/thumbprint.mjs";
import { ludionGate } from "@ludion/gate-node";

// RFC 9421 B.1.4 test-key-ed25519 (also draft -00 App. E's key). Published; REG-4 allows it by thumbprint.
const VEC_PUBLIC = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const VEC_PRIVATE = { ...VEC_PUBLIC, d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU" };
const VEC_KID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const AGENT = "https://signature-agent.test";
const NOW_S = 1_800_000_000;
const NOW = () => NOW_S * 1000;

/** The vector's request (E.2.1 or E.2.2), signed again: created now, expires in 60 s, a fresh nonce. */
async function vectorShaped(form, { url = "https://example.com/", created = NOW_S, lifetime = 60 } = {}) {
  const dict = form === "E.2.1";
  const req = { kind: "request", method: "GET", targetUri: url,
    fields: [{ name: "signature-agent", value: dict ? `agent2="${AGENT}"` : `"${AGENT}"` }] };
  const out = await createSignature(req, {
    label: "sig2", components: ["@authority", dict ? component("signature-agent", { key: "agent2" }) : "signature-agent"],
    signer: await signerFromJWK(VEC_PRIVATE),
    parameters: { created, keyid: VEC_KID, alg: "ed25519", expires: created + lifetime, nonce: generateNonce(), tag: "web-bot-auth" },
  });
  req.fields.push({ name: "signature-input", value: out.signatureInput }, { name: "signature", value: out.signature });
  return req;
}

async function gate() {
  const g = await createGate({ siteId: "site-std5", siteKey: (await generateSiteKey()).privateJwk, now: NOW, authorities: ["example.com"],
    routes: [{ match: "/**", pressure: 2 }], resolver: { fetch: async () => new Response("", { status: 404 }) } });
  await g.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...VEC_PUBLIC, use: "sig" }] });
  return g;
}

test("STD-5: the vector key is the published one (its thumbprint is the vectors' keyid)", () => {
  assert.equal(thumbprint(VEC_PUBLIC), VEC_KID);
});

test("STD-5: E.2.1 (dictionary Signature-Agent), signed again within 60 s, is VERIFIED by the Gate as the vector's agent", async () => {
  const r = await (await gate()).inspect(await vectorShaped("E.2.1"));
  assert.equal(r.cls.class, "VERIFIED", `${r.cls.class} ${r.cls.reason ?? ""} ${r.cls.detail ?? ""}`);
  assert.equal(r.cls.keyid, VEC_KID);
  assert.equal(r.cls.identifier, AGENT, "the agent the Signature-Agent names (as primed)");
  assert.equal(r.cls.label, "sig2");
  assert.equal(r.decision.action, "allow", "and passes a Pressure 2 route");
});

test("STD-5: E.2.2 (legacy string Signature-Agent), signed again within 60 s, is VERIFIED by the Gate (a verifier MAY accept it)", async () => {
  const r = await (await gate()).inspect(await vectorShaped("E.2.2"));
  assert.equal(r.cls.class, "VERIFIED", `${r.cls.class} ${r.cls.reason ?? ""} ${r.cls.detail ?? ""}`);
  assert.equal(r.cls.keyid, VEC_KID);
  assert.equal(r.cls.identifier, AGENT, "the agent the Signature-Agent names (as primed)");
});

test("STD-5: through the real Node adapter over HTTP, both forms are VERIFIED and reach the app", async () => {
  let self;
  const mw = await ludionGate({ siteId: "site-std5-node", siteKey: (await generateSiteKey()).privateJwk, now: NOW, authorities: (a) => a === self,
    routes: [{ match: "/**", pressure: 2 }], resolver: { fetch: async () => new Response("", { status: 404 }) } });
  await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...VEC_PUBLIC, use: "sig" }] });
  const srv = http.createServer((req, res) => mw(req, res, () => res.end(JSON.stringify({ class: req.ludion.cls.class, keyid: req.ludion.cls.keyid }))));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  self = `127.0.0.1:${srv.address().port}`;
  for (const form of ["E.2.1", "E.2.2"]) {
    const desc = await vectorShaped(form, { url: `http://${self}/` });
    const body = await new Promise((ok, fail) => http.get(`http://${self}/`, { headers: Object.fromEntries(desc.fields.map((f) => [f.name, f.value])), agent: false },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => ok({ status: res.statusCode, text: Buffer.concat(c).toString() })); }).on("error", fail));
    assert.equal(body.status, 200, `${form}: ${body.text}`);
    assert.deepEqual(JSON.parse(body.text), { class: "VERIFIED", keyid: VEC_KID }, form);
  }
});
