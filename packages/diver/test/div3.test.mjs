// DIV-3 (docs/MISSION.md §4): the Root key never signs requests, is never in the directory, and
// outside dev mode never lands on disk in plaintext (spec §10.3, §12.4, §8.1).
//
// "Never VERIFIED" is exercised through the real Gate resolving through the real Card Host. Where a
// publisher bypasses the Card Host and puts the Root in their own key set, the Gate still refuses
// it when the card names its Root (type=cimd). A plain directory with no card carries no Root
// identity for a Gate to check; the CLI and the Card Host are what keep the Root out of those.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, generateSiteKey } from "@ludion/gate-core";
import { createCardHost, DIRECTORY_PATH } from "@ludion/card-host";
import { createDiverSigner, openRootKey, sealRootKey, isSealedRoot, diverIdFromRoot, generateEd25519 } from "../src/index.mjs";
import { thumbprint } from "../src/thumbprint.mjs";
import { sandbox, filesUnder, seedEncodings, findEncodings, PASSPHRASE, DIRECTORY_FILE } from "./support.mjs";

const boxes = [];
const box = () => { const b = sandbox("ludion-div3-"); boxes.push(b); return b; };
after(() => boxes.forEach((b) => b.cleanup()));

const inputOf = (headers, method, url) => ({ kind: "request", method, targetUri: url, fields: Object.entries(headers).map(([name, value]) => ({ name, value })) });
const keyidOf = (signatureInput) => /keyid="([^"]+)"/.exec(signatureInput)?.[1];

/** A sealed identity made by the real CLI, with its Root opened in memory for the checks. */
async function sealedIdentity() {
  const b = box();
  const init = b.run(["init", "--name", "DIV-3 Agent", "--contact", "mailto:ops@example.test"], { env: { LUDION_ROOT_PASSPHRASE: PASSPHRASE } });
  assert.equal(init.status, 0, init.stderr);
  const store = b.read("ludion.json"), card = b.read("card"), directory = b.read(DIRECTORY_FILE);
  const root = await openRootKey(store.root, PASSPHRASE);
  return { b, store, card, directory, root };
}

/** The Gate resolving through a Card Host (or any key-set publisher) that serves `docs`. */
async function gateVia(publish) {
  const seen = [];
  const fetch = async (input, init) => { const req = new Request(String(input), init); seen.push(req.url); return publish(req); };
  const siteKey = await generateSiteKey();
  const gate = await createGate({ siteId: "site-div3", siteKey: siteKey.privateJwk, resolver: { fetch } });
  const check = async (key, signatureAgent, { cimd = false } = {}) => {
    const signer = await createDiverSigner({ sessionPrivateJwk: key, signatureAgent, cimd });
    const url = "https://shop.example/checkout/1";
    const h = await signer.headersFor({ method: "POST", url, headers: {}, body: "{}" });
    return (await gate.inspect(inputOf(h, "POST", url))).cls;
  };
  return { check, seen };
}

test("DIV-3: without dev mode, init refuses to write anything when the Root cannot be protected", () => {
  const none = box();
  const r = none.run(["init"]);
  assert.notEqual(r.status, 0, "no passphrase and no terminal: refused");
  assert.match(r.stderr, /LUDION_ROOT_PASSPHRASE/);
  assert.match(r.stderr, /--dev/);
  assert.deepEqual(none.files(), [], "nothing written anywhere (cwd, HOME, temp)");

  const weak = box();
  const w = weak.run(["init"], { env: { LUDION_ROOT_PASSPHRASE: "short" } });
  assert.notEqual(w.status, 0, "a short passphrase is refused");
  assert.deepEqual(weak.files(), [], "nothing written");
});

test("DIV-3: outside dev mode the Root private key never lands on disk in plaintext, in any encoding", async () => {
  const { b, store, card, root } = await sealedIdentity();
  // Every command that touches the identity, then every byte they left anywhere.
  for (const args of [["sign", "GET", "https://shop.example/"], ["sign", "POST", "https://shop.example/checkout/1", "--body", '{"a":1}'], ["sign", "GET", "https://shop.example/", "--curl"]]) {
    const r = b.run(args);
    assert.equal(r.status, 0, r.stderr);
  }

  // The opened key really is this identity's Root, so the search below is for the right bytes.
  assert.ok(isSealedRoot(store.root), "the stored Root is sealed");
  assert.ok(!("d" in store.root), "no private member in the stored Root");
  assert.equal(thumbprint({ kty: "OKP", crv: "Ed25519", x: root.x }), store.root.kid);
  assert.equal(card.ludion.root_kid, store.root.kid);
  assert.equal(diverIdFromRoot(root), store.diver_id);

  const needles = seedEncodings(root.d);
  const written = b.files();
  assert.ok(written.some((f) => f.endsWith("ludion.json")) && written.some((f) => f.endsWith("card")), "the scan covers what init wrote");
  const blobs = [
    ...written.map((f) => ({ where: path.relative(b.root, f), bytes: fs.readFileSync(f) })),
    ...b.outputs.flatMap((o) => [{ where: `stdout of ${o.args.join(" ")}`, bytes: o.stdout }, { where: `stderr of ${o.args.join(" ")}`, bytes: o.stderr }]),
  ];
  assert.deepEqual(findEncodings(blobs, needles), [], "Root seed found in plaintext");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(b.cwd, "ludion.json")).mode & 0o077, 0, "ludion.json is owner-only");

  // The scanner itself bites: every encoding planted in a file is found.
  const plant = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-div3-plant-"));
  try {
    for (const [name, needle] of Object.entries(needles)) fs.writeFileSync(path.join(plant, name.replace(/[^a-z0-9]+/gi, "_")), Buffer.concat([Buffer.from("x"), Buffer.isBuffer(needle) ? needle : Buffer.from(needle), Buffer.from("y")]));
    const found = new Set(findEncodings(filesUnder(plant).map((f) => ({ where: f, bytes: fs.readFileSync(f) })), needles).map((h) => h.encoding));
    assert.deepEqual([...Object.keys(needles)].filter((k) => !found.has(k)), [], "the scanner misses an encoding");
  } finally { fs.rmSync(plant, { recursive: true, force: true }); }
});

test("DIV-3: the sealed Root opens only with its passphrase and only under its own public key", async () => {
  const { store } = await sealedIdentity();
  await assert.rejects(() => openRootKey(store.root, "the wrong passphrase!!"), /wrong passphrase|modified/);
  const flip = (s) => { const b = Buffer.from(s, "base64url"); b[0] ^= 1; return b.toString("base64url"); };
  for (const field of ["ct", "tag", "iv", "salt"]) {
    await assert.rejects(() => openRootKey({ ...store.root, sealed: { ...store.root.sealed, [field]: flip(store.root.sealed[field]) } }, PASSPHRASE), undefined, `tampered ${field}`);
  }
  const other = await generateEd25519();
  await assert.rejects(() => openRootKey({ ...store.root, x: other.publicJwk.x, kid: other.kid }, PASSPHRASE), undefined, "sealed blob moved under another public key");
  await assert.rejects(() => openRootKey({ ...store.root, kid: other.kid }, PASSPHRASE), /kid/, "kid that is not the key's thumbprint");
  await assert.rejects(() => openRootKey({ ...store.root, sealed: { ...store.root.sealed, N: 2 ** 30 } }, PASSPHRASE), /range/, "a keystore cannot ask for unbounded scrypt work");
  await assert.rejects(() => sealRootKey({ ...other.privateJwk, x: store.root.x }, PASSPHRASE), /does not match/, "cannot seal a private key under a public key that is not its own");
});

test("DIV-3: dev mode is explicit and loud", () => {
  for (const how of [{ args: ["init", "--dev"] }, { args: ["init"], env: { LUDION_DEV: "1" } }]) {
    const b = box();
    const r = b.run(how.args, { env: how.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /DEV MODE/);
    assert.match(r.stderr, /PLAINTEXT/);
    const store = b.read("ludion.json");
    assert.equal(store.dev, true, "the store says it is a dev identity");
    assert.equal(typeof store.root.d, "string", "dev mode is the one place the Root is plaintext");
    const s = b.run(["sign", "GET", "https://shop.example/"]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stderr, /DEV MODE/, "every command that loads a dev identity says so");
  }
  // A plaintext Root without the dev flag (older CLI, or edited by hand) is called out too.
  const b = box();
  b.run(["init", "--dev"]);
  const store = b.read("ludion.json");
  delete store.dev;
  fs.writeFileSync(path.join(b.cwd, "ludion.json"), JSON.stringify(store));
  assert.match(b.run(["sign", "GET", "https://shop.example/"]).stderr, /plaintext/);
});

test("DIV-3: the Root key is never in the directory the CLI writes or the Card Host serves", async () => {
  const { store, card, directory } = await sealedIdentity();
  const rootKid = store.root.kid;
  assert.deepEqual(directory.keys.map((k) => thumbprint(k)), [store.session.kid], "the written directory holds the session key only");
  assert.ok(!JSON.stringify(directory).includes(store.root.x), "Root public key bytes not in the directory");

  const host = new URL(store.signature_agent).hostname;
  const rootPub = { kty: "OKP", crv: "Ed25519", x: store.root.x };
  const served = async (dir, c = card) => {
    const ch = createCardHost({ lookup: (h) => (h === host ? { directory: dir, card: c } : undefined) });
    return (await ch.fetch(new Request(`https://${host}${DIRECTORY_PATH}`))).json();
  };
  assert.deepEqual((await served(directory)).keys.map((k) => k.kid), [store.session.kid]);
  // A publisher who puts the Root in anyway: with the right kid, a wrong kid, or none.
  for (const planted of [{ ...rootPub, kid: rootKid }, { ...rootPub, kid: "not-the-thumbprint" }, rootPub, { kty: "OKP", crv: "Ed25519", x: store.session.x, kid: rootKid }]) {
    const body = await served({ keys: [...directory.keys, planted] });
    assert.ok(!body.keys.some((k) => k.x === store.root.x || k.kid === rootKid), `Root served: ${JSON.stringify(planted)}`);
    assert.ok(body.keys.some((k) => k.kid === store.session.kid), "the session key is still served");
  }
  const inline = createCardHost({ lookup: () => ({ directory, card: { ...card, jwks_uri: undefined, jwks: { keys: [...directory.keys, { ...rootPub, kid: rootKid }] } } }) });
  const inlineCard = await (await inline.fetch(new Request(`https://${host}/card`))).json();
  assert.ok(!inlineCard.jwks.keys.some((k) => k.x === store.root.x), "not in an inline card jwks either");
});

test("DIV-3: a request signed with the Root key is never VERIFIED (Gate through the Card Host)", async () => {
  const { b, store, card, directory, root } = await sealedIdentity();
  const host = new URL(store.signature_agent).hostname;
  const docs = { directory, card };
  const cardHost = createCardHost({ lookup: (h) => (h === host ? docs : undefined) });
  const { check, seen } = await gateVia((req) => cardHost.fetch(req));
  const agent = store.signature_agent;

  // Controls first: the setup verifies the session key, so a refusal below means something.
  assert.equal((await check(store.session, agent)).class, "VERIFIED", "control: session key, directory discovery");
  assert.equal((await check(store.session, agent, { cimd: true })).class, "VERIFIED", "control: session key, card discovery");
  for (const cimd of [false, true]) {
    const cls = await check(root, agent, { cimd });
    assert.notEqual(cls.class, "VERIFIED", `Root signed (${cimd ? "cimd" : "directory"}): ${JSON.stringify(cls)}`);
  }
  assert.ok(seen.includes(`${agent}${DIRECTORY_PATH}`) && seen.includes(`${agent}/card`), "the Gate really resolved through the Card Host");

  // A Card Host handed a directory with the Root in it (misconfiguration) still never lets it verify.
  const leaky = { directory: { keys: [...directory.keys, { kty: "OKP", crv: "Ed25519", x: root.x, kid: root.kid }] }, card };
  const misHost = createCardHost({ lookup: (h) => (h === host ? leaky : undefined) });
  const g2 = await gateVia((req) => misHost.fetch(req));
  assert.equal((await g2.check(store.session, agent)).class, "VERIFIED", "control");
  for (const cimd of [false, true]) assert.notEqual((await g2.check(root, agent, { cimd })).class, "VERIFIED", `Root via a leaky directory (${cimd ? "cimd" : "directory"})`);

  // A self-hosted publisher that bypasses the Card Host: the Gate refuses the key the card names as Root.
  const selfHosted = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/card") return new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } });
    if (u.pathname === DIRECTORY_PATH) return new Response(JSON.stringify({ keys: [...directory.keys, { kty: "OKP", crv: "Ed25519", x: root.x, kid: root.kid }] }), { headers: { "content-type": "application/http-message-signatures-directory+json" } });
    return new Response("", { status: 404 });
  };
  const g3 = await gateVia(selfHosted);
  assert.equal((await g3.check(store.session, agent, { cimd: true })).class, "VERIFIED", "control");
  assert.notEqual((await g3.check(root, agent, { cimd: true })).class, "VERIFIED", "Root named by the card is refused whatever the key set says");

  // And the CLI itself only ever signs with the session key.
  const s = b.run(["sign", "POST", "https://shop.example/checkout/1", "--body", "{}"]);
  assert.equal(s.status, 0, s.stderr);
  const kid = keyidOf(/^signature-input: (.*)$/m.exec(s.stdout)?.[1] ?? "");
  assert.equal(kid, store.session.kid, "ludion sign uses the session key");
  assert.notEqual(kid, store.root.kid);
});
