import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, base32, createDiverSigner } from "../src/index.mjs";
import { parseSignatureAgentCard, parseSignatureAgentHeader } from "web-bot-auth";

test("diver_id: dvr- + 16 base32 chars, deterministic from Root public key", async () => {
  const root = await generateEd25519();
  const id = diverIdFromRoot(root.publicJwk);
  assert.match(id, /^dvr-[a-z2-7]{16}$/);
  assert.equal(id, diverIdFromRoot({ kty: "OKP", crv: "Ed25519", x: root.publicJwk.x }));
  assert.equal(base32(new Uint8Array([0x66, 0x6f, 0x6f])), "mzxw6"); // RFC 4648 "foo"
});

test("directory contains session keys with kid=thumbprint; card is a valid Signature Agent Card (CIMD)", async () => {
  const s = await generateEd25519();
  const dir = directoryDocument([s.publicJwk], { nbf: 1, exp: 2 });
  assert.equal(dir.keys[0].kid, s.kid);
  assert.equal(dir.keys[0].use, "sig");
  assert.ok(!("d" in dir.keys[0]));
  const card = cardDocument({ origin: "https://dvr-k7q2m6x4pcab3cde.agents.ludion.ai/", name: "X", contacts: ["mailto:a@b.c"], ludion: { diver_id: "dvr-k7q2m6x4pcab3cde" } });
  const parsed = parseSignatureAgentCard(card, card.client_id);
  assert.equal(parsed.client_id, "https://dvr-k7q2m6x4pcab3cde.agents.ludion.ai/card");
  assert.equal(parsed.jwks_uri, "https://dvr-k7q2m6x4pcab3cde.agents.ludion.ai/.well-known/http-message-signatures-directory");
  assert.equal(card.ludion.diver_id, "dvr-k7q2m6x4pcab3cde");
});

test("signer emits dictionary Signature-Agent, covers @method/@path/content-digest on POST, 60s lifetime, nonce", async () => {
  const s = await generateEd25519();
  const signer = await createDiverSigner({ sessionPrivateJwk: s.privateJwk, signatureAgent: "https://dvr-x.agents.ludion.ai", now: () => 1_800_000_000_000 });
  const h = await signer.headersFor({ method: "POST", url: "https://shop.example/checkout/1", headers: {}, body: "{}" });
  const sa = parseSignatureAgentHeader(h["signature-agent"]);
  assert.equal(sa.kind, "current");
  assert.deepEqual(sa.entries[0], { label: "sig1", uri: "https://dvr-x.agents.ludion.ai", type: "directory" });
  assert.match(h["signature-input"], /"@method" "@path" "content-digest"/);
  assert.match(h["signature-input"], /created=1800000000;.*expires=1800000060/);
  assert.match(h["signature-input"], /nonce="[^"]{20,}"/);
  assert.match(h["signature-input"], /tag="web-bot-auth"/);
  assert.match(h["content-digest"], /^sha-256=:[A-Za-z0-9+/=]+:$/);
  const cimd = await createDiverSigner({ sessionPrivateJwk: s.privateJwk, signatureAgent: "https://dvr-x.agents.ludion.ai", cimd: true });
  const h2 = await cimd.headersFor({ method: "GET", url: "https://shop.example/", headers: {} });
  assert.equal(parseSignatureAgentHeader(h2["signature-agent"]).entries[0].type, "cimd");
});

test("signer refuses non-https signature-agent unless explicitly insecure", async () => {
  const s = await generateEd25519();
  await assert.rejects(() => createDiverSigner({ sessionPrivateJwk: s.privateJwk, signatureAgent: "http://x.test" }), /https/);
});
