// GATE-7 replay-cache flooding, pinned from both sides. The seed cache dropped its oldest tenth
// when full, live or not: anyone with a valid key of their own could flood it and then replay a
// victim's captured request inside its validity (reproduced: VERIFIED after 60 requests into a
// 50-entry cache). Now a live entry is never evicted; memory is bounded by refusing to record,
// and the refusal lands on whoever holds the most (the flooder), not on the victim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNonceCache, createGate, generateSiteKey } from "../src/index.mjs";
import { keypair, signed, harness, NOW_MS, AGENT, ATTACKER } from "./support.mjs";

test("GATE-7: a live entry is never evicted, however much is recorded after it; expired ones make room", () => {
  let t = 0;
  const c = createNonceCache({ maxEntries: 10, now: () => t });
  assert.equal(c.record("victim", 90_000, "agent"), "fresh");
  const outcomes = [];
  for (let i = 0; i < 100; i++) outcomes.push(c.record(`k${i}`, 90_000, `owner${i}`));
  assert.ok(c.size() <= 10, "bounded");
  assert.equal(c.record("victim", 90_000, "agent"), "replay", "the victim's nonce survived the flood");
  assert.ok(outcomes.includes("full"), "a cache full of live entries refuses to record");
  t = 95_000; // everything expired
  assert.equal(c.record("new", 185_000, "someone"), "fresh", "expired entries make room");
  assert.equal(c.record("victim", 185_000, "agent"), "fresh", "an expired nonce may be used again");
});

test("GATE-7: once half full, an owner holding its share is refused ('quota') while others still record", () => {
  const c = createNonceCache({ maxEntries: 40, now: () => 0 });
  const flood = [];
  for (let i = 0; i < 60; i++) flood.push(c.record(`a${i}`, 90_000, "flooder"));
  assert.equal(flood.filter((s) => s === "fresh").length, 20, "the flooder records until the cache is half full");
  assert.ok(flood.slice(20).every((s) => s === "quota"));
  for (let i = 0; i < 10; i++) assert.equal(c.record(`b${i}`, 90_000, `other${i}`), "fresh", "others are not locked out");
  assert.equal(createNonceCache({ maxEntries: 40, perOwnerMax: 30, now: () => 0 }).record("x", 1, "o"), "fresh");
});

test("GATE-7: below half full, heavy legitimate traffic from one signer is never refused", () => {
  const c = createNonceCache({ maxEntries: 1000, now: () => 0 });
  for (let i = 0; i < 499; i++) assert.equal(c.record(`n${i}`, 90_000, "big-operator"), "fresh");
});

test("GATE-7: through the Gate — the flooder turns UNVERIFIED, the victim signing afresh stays VERIFIED, the victim's captured request stays a replay", async () => {
  const [agent, attacker] = await Promise.all([keypair(), keypair()]);
  const gate = await harness({ agentKeys: [agent], attackerKeys: [attacker], nonceCache: { maxEntries: 40 } });
  const captured = await signed({ key: agent });
  assert.equal((await gate.inspect(captured)).cls.class, "VERIFIED");
  const classes = [];
  for (let i = 0; i < 60; i++) classes.push((await gate.inspect(await signed({ key: attacker, agent: ATTACKER }))).cls);
  assert.ok(classes.slice(-10).every((c) => c.class === "UNVERIFIED" && c.reason === "replay_quota"), "the flooder is the one refused");
  const fresh = await gate.inspect(await signed({ key: agent }));
  assert.equal(fresh.cls.class, "VERIFIED");
  assert.equal(fresh.cls.identifier, AGENT);
  const replay = await gate.inspect(captured);
  assert.equal(replay.cls.class, "SPOOFED");
  assert.equal(replay.cls.reason, "replay");
  assert.equal(replay.decision.action, "deny");
});

test("GATE-7: a replay cache that cannot record is never a reason to VERIFY, and a nonsensical size is a TypeError at startup", async () => {
  const [agent] = await Promise.all([keypair()]);
  const gate = await harness({ agentKeys: [agent], nonceCache: { maxEntries: 2, perOwnerMax: 100 } });
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push((await gate.inspect(await signed({ key: agent }))).cls);
  assert.deepEqual(outs.map((c) => c.class), ["VERIFIED", "VERIFIED", "UNVERIFIED", "UNVERIFIED"]);
  assert.equal(outs[3].reason, "replay_cache_full");
  const siteKey = (await generateSiteKey()).privateJwk;
  for (const maxEntries of [0, 1, 1.5, -5, NaN]) await assert.rejects(createGate({ siteId: "s", siteKey, now: () => NOW_MS, nonceCache: { maxEntries } }), TypeError, String(maxEntries));
});
