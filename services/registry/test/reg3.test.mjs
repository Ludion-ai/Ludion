// REG-3 (±): revocation reaches Gates subscribed to the Registry's stream within 60 s (also across a
// stream outage), and every other Gate within a Staple's lifetime (≤ 1 h). Revoked → REVOKED and
// denied where standing is required; everyone else stays VERIFIED (spec §10.10).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registryServer, recordingProxy, site, agent, directoryHost, testClock } from "./world.mjs";

const SKEW_S = 30, LIMIT_MS = 60_000;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } } });

async function waitFor(pred, limitMs) {
  const t = performance.now();
  while (!pred()) {
    if (performance.now() - t > limitMs) return Infinity;
    await new Promise((r) => setTimeout(r, 5));
  }
  return performance.now() - t;
}

test("REG-3: subscribed Gates apply a revocation within 60 s, others within the Staple lifetime; the rest stay VERIFIED", { timeout: 180_000 }, async () => {
  const clock = testClock();
  const reg = await registryServer({ now: () => clock.now(), sseRetryMs: 200 });
  cleanups.push(() => reg.close());
  const proxy = await recordingProxy(reg.server.address().port); // the stream's path, which the test can cut
  cleanups.push(() => proxy.close());
  const directory = directoryHost();
  const registryKeys = reg.registry.publicKeys;
  const S = await site({ host: "subscribed.example", clock, registryKeys, directory, revocations: { url: `${proxy.url}/v0/revocations/stream`, retryMs: 200, maxRetryMs: 1000 } });
  const U = await site({ host: "unsubscribed.example", clock, registryKeys, directory });
  cleanups.push(() => S.close(), () => U.close());
  const [A, B, C] = await Promise.all(["A", "B", "C"].map((name) => agent({ registryUrl: reg.url, clock, directory, name: `REG-3 ${name}` })));
  assert.notEqual(await waitFor(() => S.gate.health.revocations.state === "open", 5000), Infinity, "the Gate is subscribed");

  const call = async (g, x, path = "/checkout/1", o = {}) => g.send(path, await x.headers(g.host, path, o));
  const standing = (r) => r.status === 200 && r.body.class === "VERIFIED" && r.body.ballast === "active" && r.body.depth === 1;
  for (const g of [S, U]) for (const x of [A, B, C]) assert.ok(standing(await call(g, x)), "before: everyone VERIFIED with standing");

  // 1. Live: A's Root revokes A. The subscribed Gate applies it within seconds.
  const t0 = performance.now();
  const revokedAtS = Math.floor(clock.now() / 1000);
  await A.client.revoke(A.store, A.root, { reason: "compromised" });
  const live = await waitFor(() => S.gate.revocations.match({ sub: A.store.diver_id }), LIMIT_MS);
  const liveMs = performance.now() - t0;
  assert.ok(live !== Infinity && liveMs <= LIMIT_MS, `subscribed Gate within 60 s (took ${liveMs.toFixed(0)} ms)`);
  let r = await call(S, A);
  assert.equal(r.status, 403); assert.equal(r.error, "revoked", "A's Staple no longer opens the route");
  r = await call(S, A, "/checkout/1", { withStaple: false });
  assert.equal(r.error, "revoked", "nor does A's key without a Staple");
  r = await call(S, A, "/about");
  assert.equal(r.status, 200, "an unprotected route still answers"); assert.equal(r.body.class, "REVOKED", "but A is classified REVOKED");
  for (const x of [B, C]) assert.ok(standing(await call(S, x)), "B and C stay VERIFIED");

  // 2. Across an outage: the stream is cut, C is revoked while the Gate cannot hear, the stream comes back.
  proxy.goDark();
  await waitFor(() => S.gate.health.revocations.state !== "open", 5000);
  const t1 = performance.now();
  await C.client.revoke(C.store, C.root, { reason: "compromised" });
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(S.gate.revocations.match({ sub: C.store.diver_id }), undefined, "nothing reaches a Gate that cannot hear");
  proxy.goLight();
  const outage = await waitFor(() => S.gate.revocations.match({ sub: C.store.diver_id }), LIMIT_MS);
  const outageMs = performance.now() - t1;
  assert.ok(outage !== Infinity && outageMs <= LIMIT_MS, `caught up after the outage within 60 s of the revocation (took ${outageMs.toFixed(0)} ms)`);
  assert.equal((await call(S, C)).error, "revoked");
  assert.ok(standing(await call(S, B)), "B still VERIFIED");

  // 3. The unsubscribed Gate: it learns through Staples. A's pre-revocation Staple is honoured until
  //    it expires (≤ 1 h); every Staple the Registry issues A from now on is revoked.
  const old = A.staple;
  assert.ok(old.exp - old.iat <= 3600, "Staples live at most an hour");
  assert.ok(standing(await call(U, A)), "before its expiry, U still accepts A's last good Staple (the TTL is the bound)");
  const fresh = await A.refresh();
  assert.equal(fresh.revoked, true, "the Registry only issues revoked Staples to a revoked Diver");
  r = await call(U, A);
  assert.equal(r.status, 403); assert.equal(r.error, "revoked", "an agent carrying the Registry's current answer is REVOKED everywhere");
  // At the end of the old Staple's lifetime (+ skew), A has no way left to standing at U:
  clock.advanceTo((old.exp + SKEW_S + 1) * 1000);
  A.staple = old;
  r = await call(U, A);
  assert.equal(r.status, 401); assert.equal(r.error, "staple_expired", "the last good Staple has expired");
  A.staple = await A.refresh();
  assert.equal(A.staple.revoked, true);
  r = await call(U, A);
  assert.equal(r.error, "revoked", "a fresh one says REVOKED");
  r = await call(U, A, "/checkout/1", { withStaple: false });
  assert.equal(r.status, 403, "without a Staple there is no standing either"); assert.equal(r.error, "depth_insufficient");
  assert.ok(old.iat <= revokedAtS && old.exp - revokedAtS <= 3600, "so the unsubscribed Gate is reached within one Staple lifetime (≤ 1 h) of the revocation");
  // B, refreshed on the moved clock, is VERIFIED at both Gates.
  await B.refresh();
  for (const g of [S, U]) assert.ok(standing(await call(g, B)), "B stays VERIFIED at every Gate");

  console.log(`REG-3: subscribed ${liveMs.toFixed(0)} ms, after a stream outage ${outageMs.toFixed(0)} ms, unsubscribed ≤ ${old.exp - old.iat} s`);
});
