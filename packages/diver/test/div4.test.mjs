// DIV-4 (docs/MISSION.md §4, ±): rotating the Session key keeps the identifier; the old key stops
// verifying once a Gate's cached directory expires; the new key verifies (spec §10.3, §8.1).
//
// Time is injected (Gate, resolver cache, nonce cache, signer), never slept. The real CLI rotates;
// the real Card Host serves whatever the CLI last wrote; the real Gate resolves through it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createGate, generateSiteKey } from "@ludion/gate-core";
import { createCardHost, DIRECTORY_PATH } from "@ludion/card-host";
import { createDiverSigner, rotateSession, RotationPendingError, DEFAULT_OVERLAP_S, directoryDocument } from "../src/index.mjs";
import { sandbox, filesUnder, PASSPHRASE, DIRECTORY_FILE } from "./support.mjs";

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));

const T0 = 1_790_000_000_000;
const CACHE_S = 300; // the Card Host's max-age: how long a Gate trusts a fetched directory

/** A Gate at clock `clock.t`, resolving through `publish(request)`. */
async function gateAt(clock, publish) {
  const siteKey = await generateSiteKey();
  const gate = await createGate({ siteId: "site-div4", siteKey: siteKey.privateJwk, now: () => clock.t,
    resolver: { fetch: async (input, init) => publish(new Request(String(input), init)) } });
  return async (sessionJwk, agent, { cimd = false } = {}) => {
    const signer = await createDiverSigner({ sessionPrivateJwk: sessionJwk, signatureAgent: agent, cimd, now: () => clock.t });
    const url = "https://shop.example/api/items";
    const h = await signer.headersFor({ method: "GET", url, headers: {} });
    return (await gate.inspect({ kind: "request", method: "GET", targetUri: url, fields: Object.entries(h).map(([name, value]) => ({ name, value })) })).cls;
  };
}

test("DIV-4: rotation keeps the identifier; the old key stops once the Gate's cache expires; the new key verifies", async () => {
  const b = sandbox("ludion-div4-"); boxes.push(b);
  assert.equal(b.run(["init", "--name", "DIV-4 Agent"], { env: { LUDION_ROOT_PASSPHRASE: PASSPHRASE } }).status, 0);
  const before = { store: b.read("ludion.json"), card: fs.readFileSync(path.join(b.cwd, "card"), "utf8") };
  const agent = before.store.signature_agent, host = new URL(agent).hostname;
  // The Card Host serves exactly what the CLI last wrote, read fresh on every request.
  const cardHost = createCardHost({ lookup: (h) => (h === host ? { directory: b.read(DIRECTORY_FILE), card: b.read("card") } : undefined) });
  const clock = { t: T0 };
  const verify = await gateAt(clock, (req) => cardHost.fetch(req));
  const S0 = before.store.session;

  const v0 = await verify(S0, agent), c0 = await verify(S0, agent, { cimd: true });
  assert.equal(v0.class, "VERIFIED"); assert.equal(c0.class, "VERIFIED");

  // Step 1: publish the next key. No passphrase: rotation never needs the Root.
  const r1 = b.run(["rotate"]);
  assert.equal(r1.status, 0, r1.stderr);
  const mid = b.read("ludion.json");
  const S1 = mid.next;
  assert.ok(S1?.d && S1.kid !== S0.kid, "a new session key is pending");
  assert.equal(mid.session.kid, S0.kid, "still signing with the current key");
  assert.deepEqual(b.read(DIRECTORY_FILE).keys.map((k) => k.kid).sort(), [S0.kid, S1.kid].sort(), "both keys published");
  assert.equal((await verify(S0, agent)).class, "VERIFIED", "the current key keeps working while the next one propagates");

  // Switching before the overlap is refused: some Gate could still cache a directory without S1.
  const early = b.run(["rotate"]);
  assert.notEqual(early.status, 0, "activation before the overlap is refused");
  assert.match(early.stderr, /becomes active at/);
  assert.equal(b.read("ludion.json").session.kid, S0.kid, "nothing changed");

  // The Gate's cache expires; it refetches and now knows both keys.
  clock.t += (CACHE_S + 1) * 1000;
  assert.equal((await verify(S0, agent)).class, "VERIFIED");

  // Step 2: activate (the overlap has elapsed on the Gate's clock; the CLI's clock is real time).
  const r2 = b.run(["rotate", "--force"]);
  assert.equal(r2.status, 0, r2.stderr);
  const afterStore = b.read("ludion.json");
  assert.equal(afterStore.session.kid, S1.kid, "signing with the new key");
  assert.equal(afterStore.next, undefined);
  assert.deepEqual(b.read(DIRECTORY_FILE).keys.map((k) => k.kid), [S1.kid], "the old key left the directory");
  assert.ok(!filesUnder(b.root).some((f) => fs.readFileSync(f).includes(Buffer.from(S0.d))), "the old session private key is gone from disk");

  // The new key verifies at once at this Gate, with the same identifiers.
  const v1 = await verify(S1, agent), c1 = await verify(S1, agent, { cimd: true });
  assert.equal(v1.class, "VERIFIED", JSON.stringify(v1));
  assert.equal(c1.class, "VERIFIED", JSON.stringify(c1));
  assert.equal(v1.identifier, v0.identifier, "same directory identifier");
  assert.equal(c1.identifier, c0.identifier, "same card identifier");
  assert.notEqual(v1.keyid, v0.keyid, "a different key");

  // Once the cached directory expires, the old key stops; the new one keeps working.
  clock.t += (CACHE_S + 1) * 1000;
  for (const cimd of [false, true]) {
    const old = await verify(S0, agent, { cimd });
    assert.notEqual(old.class, "VERIFIED", `old key after cache expiry (${cimd ? "cimd" : "directory"}): ${JSON.stringify(old)}`);
    assert.equal((await verify(S1, agent, { cimd })).class, "VERIFIED");
  }

  // A Gate that never saw the old directory: the old key never works, the new one does.
  const fresh = await gateAt(clock, (req) => cardHost.fetch(req));
  assert.notEqual((await fresh(S0, agent)).class, "VERIFIED");
  assert.equal((await fresh(S1, agent)).class, "VERIFIED");

  // The identity did not move: same diver, origin, card (byte for byte) and Root.
  assert.equal(afterStore.diver_id, before.store.diver_id);
  assert.equal(afterStore.signature_agent, before.store.signature_agent);
  assert.deepEqual(afterStore.root, before.store.root, "the sealed Root is untouched");
  assert.equal(fs.readFileSync(path.join(b.cwd, "card"), "utf8"), before.card, "the card is unchanged");
  const s = b.run(["sign", "GET", "https://shop.example/"]);
  assert.match(s.stdout, new RegExp(`keyid="${S1.kid}"`), "`ludion sign` uses the new key");
});

test("DIV-4: the default overlap outlives every cached directory, so the new key is never met unknown", async () => {
  // Library-level timeline with one clock. A Gate caches the directory at t, just before the
  // next key is published; activation happens at t + overlap, when that cache has expired.
  const { generateEd25519 } = await import("../src/index.mjs");
  const s0 = await generateEd25519();
  const agent = "https://dvr-aaaaaaaaaaaaaaaa.agents.ludion.ai", host = new URL(agent).hostname;
  let store = { v: 0, diver_id: "dvr-aaaaaaaaaaaaaaaa", signature_agent: agent, session: s0.privateJwk };
  let directory = directoryDocument([s0.publicJwk]);
  const cardHost = createCardHost({ lookup: (h) => (h === host ? { directory } : undefined) });
  const clock = { t: T0 };
  const verify = await gateAt(clock, (req) => cardHost.fetch(req));
  assert.equal((await verify(store.session, agent)).class, "VERIFIED", "the Gate caches [S0] at t");

  const p = await rotateSession(store, { now: clock.t });
  assert.equal(p.step, "published");
  assert.equal(p.activeAt - clock.t, DEFAULT_OVERLAP_S * 1000);
  assert.ok(DEFAULT_OVERLAP_S >= CACHE_S, "the overlap covers the Card Host's max-age");
  store = p.store; directory = p.directory;

  clock.t = p.activeAt - 1000;
  await assert.rejects(() => rotateSession(store, { now: clock.t }), RotationPendingError, "not before the overlap");
  clock.t = p.activeAt;
  const a = await rotateSession(store, { now: clock.t });
  assert.equal(a.step, "activated");
  store = a.store; directory = a.directory;
  const cls = await verify(store.session, agent);
  assert.equal(cls.class, "VERIFIED", `the new key at the moment it is first used: ${JSON.stringify(cls)}`);
  assert.ok(!("next" in store) && store.session.kid !== s0.kid);
  await assert.rejects(() => rotateSession(store, { now: clock.t, overlapS: -1 }), /non-negative/);
});
