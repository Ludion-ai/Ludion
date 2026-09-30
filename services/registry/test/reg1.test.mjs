// REG-1 (+, pair REG-2): the Registry is off the hot path. Kill its process and every Gate keeps
// verifying Staples until they expire; sites see no errors and no added latency. After expiry,
// without a refresh, the standing is gone (spec §9.1, §13.5, invariant 7).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { registryProcess, site, agent, directoryHost, testClock, tmpdir, pct } from "./world.mjs";

const SKEW_S = 30;
const dir = tmpdir("reg1");
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

const refused = (url) => new Promise((resolve) => {
  const { hostname, port } = new URL(url);
  const s = net.connect(Number(port), hostname);
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

test("REG-1: with the Registry killed, Gates keep verifying Staples until they expire; sites are unaffected", { timeout: 120_000 }, async () => {
  const problems = [];
  const onRejection = (e) => problems.push(`unhandled rejection: ${e?.message ?? e}`);
  const onException = (e) => problems.push(`uncaught exception: ${e?.message ?? e}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  cleanups.push(() => { process.off("unhandledRejection", onRejection); process.off("uncaughtException", onException); });
  const reg = await registryProcess({ dir, args: ["--dev-verified-contacts", "--sse-retry-ms", "100"] });
  cleanups.push(() => reg.child.kill("SIGKILL"));
  const clock = testClock();
  const directory = directoryHost();
  const registryKeys = await (await fetch(`${reg.url}/.well-known/ludion-keys`)).json();
  // A Gate that subscribes to the revocation stream (so it has something to lose) and one that doesn't.
  const subscribed = await site({ host: "shop.example", clock, registryKeys, directory, revocations: { url: `${reg.url}/v0/revocations/stream`, retryMs: 100, maxRetryMs: 400 } });
  const plain = await site({ host: "plain.example", clock, registryKeys, directory });
  cleanups.push(() => subscribed.close(), () => plain.close());
  const a = await agent({ registryUrl: reg.url, clock, directory, name: "REG-1 agent" });
  const staple = a.staple;
  assert.ok(staple.exp - staple.iat <= 3600);

  const round = async (gate, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await gate.send(`/checkout/${i}`, await a.headers(gate.host, `/checkout/${i}`)));
    return out;
  };
  const standing = (r) => r.status === 200 && r.body.class === "VERIFIED" && r.body.depth === 1 && r.body.ballast === "active";

  // Registry up: the baseline.
  for (let t = 0; t < 50 && subscribed.gate.health.revocations.state !== "open"; t++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(subscribed.gate.health.revocations.state, "open", "the Gate is subscribed");
  await round(subscribed, 20); await round(plain, 20); // warm up (key discovery cached)
  const upS = await round(subscribed, 200), upP = await round(plain, 200);
  assert.ok([...upS, ...upP].every(standing), "Registry up: Staple standing verified");

  // Kill the Registry. Nothing listens on its port any more.
  await reg.kill();
  assert.ok(await refused(reg.url), "the Registry is gone");
  await new Promise((r) => setTimeout(r, 600)); // let the subscription notice and start retrying

  // Registry down: same answers, no errors, no added latency beyond noise and never near the budget.
  const downS = await round(subscribed, 200), downP = await round(plain, 200);
  assert.ok([...downS, ...downP].every(standing), "Registry down: every Staple still verifies with its standing");
  assert.notEqual(subscribed.gate.health.revocations.state, "open", "the Gate knows its stream is down");
  const p99 = (rs) => pct(rs.map((r) => r.ms), 99);
  const added = Math.max(p99(downS) - p99(upS), p99(downP) - p99(upP));
  assert.ok(added < 5, `no added latency with the Registry down (p99 +${added.toFixed(2)} ms)`);
  assert.ok([...downS, ...downP].every((r) => r.ms < subscribed.gate.timeoutMs), "within the Gate's budget");

  // A Gate that starts while the Registry is down (pinned keys) verifies too.
  const late = await site({ host: "late.example", clock, registryKeys, directory, revocations: { url: `${reg.url}/v0/revocations/stream`, retryMs: 100 } });
  cleanups.push(() => late.close());
  assert.ok((await round(late, 20)).every(standing), "a Gate started during the outage verifies from its pinned keys");

  // Humans and unprotected routes: untouched throughout.
  for (const g of [subscribed, plain, late]) {
    const human = await g.send("/", { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15" });
    assert.equal(human.status, 200); assert.equal(human.body.class, "UNKNOWN");
  }

  // Just before expiry: still standing.
  clock.advanceTo(staple.exp * 1000 - 5000);
  assert.ok((await round(subscribed, 5)).every(standing) && (await round(plain, 5)).every(standing), "standing until the Staple's exp");

  // After expiry (+ the ±30 s skew), with no refresh possible: the standing is gone.
  clock.advanceTo((staple.exp + SKEW_S + 1) * 1000);
  for (const g of [subscribed, plain, late]) {
    const r = await g.send("/checkout/1", await a.headers(g.host, "/checkout/1"));
    assert.equal(r.status, 401); assert.equal(r.error, "staple_expired", "an expired Staple carries no standing");
    const open = await g.send("/about", await a.headers(g.host, "/about"));
    assert.equal(open.status, 200, "unprotected routes still answer"); assert.equal(open.body.class, "VERIFIED");
    const human = await g.send("/checkout/1", { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
    assert.equal(human.status, 200, "humans are never touched");
  }
  await assert.rejects(a.refresh(), /fetch failed|ECONNREFUSED/, "and no fresh Staple can be had while the Registry is down");

  assert.deepEqual(problems, [], "no errors anywhere while the Registry was down");
});
