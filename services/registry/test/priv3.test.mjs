// PRIV-3 (−): the Registry never learns where an agent goes (spec §10.5, invariant 8). Across a
// Diver's whole life — init, register, Staple refreshes, rotation, revoke — while it visits sites,
// every byte the Registry receives (recorded at the socket, in front of it) holds no site origin,
// URL, path or query value. The Gates' revocation subscription reveals no visitor either.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDiverSigner, createRegistryClient, createStapleKeeper } from "@ludion/diver";
import { registryServer, recordingProxy, site, directoryHost, testClock, tmpdir } from "./world.mjs";

const CLI = fileURLToPath(new URL("../../../packages/diver/bin/ludion.mjs", import.meta.url));
const dir = tmpdir("priv3");
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

// Where the agent goes. Every one of these strings is a canary.
const SITES = [
  { host: "canary-shop-q7x2.example", paths: ["/checkout/canary-order-8841?q=canary-query-3310&ref=canary-ref-7702", "/cart/canary-sku-5521"] },
  { host: "canary-travel-m4k9.example", paths: ["/reserve/canary-flight-2207?date=canary-date-9164", "/account/canary-user-4418"] },
  { host: "canary-news-z3p8.example", paths: ["/articles/canary-story-6035", "/"] },
];
function canaries() {
  const out = new Set();
  for (const s of SITES) {
    out.add(s.host); out.add(`https://${s.host}`); out.add(s.host.split(".")[0]);
    for (const p of s.paths) {
      out.add(`https://${s.host}${p}`);
      const u = new URL(p, `https://${s.host}`);
      if (u.pathname !== "/") out.add(u.pathname);
      for (const seg of u.pathname.split("/")) if (seg.includes("canary")) out.add(seg);
      for (const [k, v] of u.searchParams) { out.add(v); out.add(`${k}=${v}`); }
      if (u.search) out.add(u.search);
    }
  }
  return [...out];
}
/** The ways a string can hide in bytes on the wire. */
function forms(s) {
  const b = Buffer.from(s);
  return [...new Set([s, s.toLowerCase(), s.toUpperCase(), encodeURIComponent(s), encodeURI(s), JSON.stringify(s).slice(1, -1),
    b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), b.toString("hex")])].filter((f) => f.length >= 4);
}

test("PRIV-3: across the Diver lifecycle the Registry receives no site origin, URL or path, and Gates subscribe without naming visitors", { timeout: 180_000 }, async () => {
  const reg = await registryServer({ sseRetryMs: 200 });
  cleanups.push(() => reg.close());
  const proxy = await recordingProxy(reg.server.address().port);
  cleanups.push(() => proxy.close());
  const REG = proxy.url;
  const env = { ...process.env, LUDION_ROOT_PASSPHRASE: "priv3 correct horse battery staple" };
  delete env.LUDION_DEV;
  // Async: the Registry and the proxy live in this process and must keep answering meanwhile.
  const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
  const readStore = () => JSON.parse(fs.readFileSync(path.join(dir, "ludion.json"), "utf8"));

  // init (no network) → register (Root: registration + key approval, then a Staple)
  await cli("init", "--name", "PRIV-3 agent", "--contact", "mailto:ops@example.test");
  await cli("register", "--registry", REG);
  let store = readStore();
  assert.ok(store.staple?.staple, "registered and holding a Staple");

  // The sites run the real Gate; the first subscribes to the revocation stream through the proxy.
  const clock = testClock();
  const directory = directoryHost();
  directory.publish(store);
  const gates = [];
  for (const [i, s] of SITES.entries()) {
    const g = await site({ host: s.host, clock, registryKeys: reg.registry.publicKeys, directory,
      routes: [{ match: "/checkout/**", pressure: 2, require: { depth: 1, ballast: "active" } }, { match: "/reserve/**", pressure: 2, require: { ballast: "active" } }, { match: "/account", pressure: 2 }],
      ...(i === 0 ? { revocations: { url: `${REG}/v0/revocations/stream`, retryMs: 200, maxRetryMs: 1000 } } : {}) });
    cleanups.push(() => g.close());
    gates.push(g);
  }

  // Visiting the sites through the SDK, with Staple refreshes between every visit.
  let visits = 0;
  async function tour(storeNow, stapleOf) {
    for (const [i, s] of SITES.entries()) for (const p of s.paths) {
      const signer = await createDiverSigner({ sessionPrivateJwk: storeNow.session, signatureAgent: storeNow.signature_agent, staple: stapleOf, now: () => clock.now() });
      const u = new URL(p, `https://${s.host}`);
      const r = await gates[i].send(u.pathname + u.search, await signer.headersFor({ method: "GET", url: u.href }));
      assert.equal(r.status, 200, `${s.host}${p}: the Gate lets the agent through (${r.error})`);
      assert.equal(r.body.class, "VERIFIED");
      visits++;
      await refresh();
    }
  }
  const client = createRegistryClient({ url: REG });
  let keeper = createStapleKeeper({ client, store, sessionPrivateJwk: store.session });
  let refresh = () => keeper.refresh();
  await keeper.start();
  await tour(store, () => keeper.current());
  keeper.stop();

  await cli("staple");                              // CLI refresh
  await cli("rotate", "--overlap", "0");            // next key published and approved (Root)
  store = readStore(); directory.publish(store);
  clock.advanceTo(clock.now() + 61_000);            // the overlap, compressed: Gates' cached directories refresh
  await cli("rotate");                              // switch: a Staple for the new key
  store = readStore(); directory.publish(store);
  keeper = createStapleKeeper({ client, store, sessionPrivateJwk: store.session });
  refresh = () => keeper.refresh();
  await keeper.start();
  await tour(store, () => keeper.current());
  keeper.stop();

  await cli("revoke", "--compromised");             // Root
  const t = performance.now();
  while (!gates[0].gate.revocations.match({ sub: store.diver_id }) && performance.now() - t < 10_000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(gates[0].gate.revocations.match({ sub: store.diver_id }), "the subscribed Gate heard the revocation (the stream really ran)");

  // Everything the Registry received, byte for byte.
  const conns = proxy.received();
  const all = conns.join("\n");
  const leaks = [];
  for (const c of canaries()) for (const f of forms(c)) if (all.includes(f)) leaks.push(`${c} (as ${f})`);
  assert.deepEqual(leaks, [], "no site origin, URL, path or query value reached the Registry");

  // What the Registry was asked: only the Diver's own business, and the stream.
  // Not anchored to a line start: on a kept-alive connection a request line follows the previous body.
  const requestLines = conns.flatMap((c) => [...c.matchAll(/(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) (\S+) HTTP\/1\.[01]\r\n/g)].map((m) => `${m[1]} ${m[2]} HTTP/1.1`));
  const allowed = /^(POST \/v0\/divers|POST \/v0\/divers\/dvr-[a-z2-7]{16}\/(keys|staple)|POST \/v0\/revocations|GET \/v0\/revocations\/stream(\?since=\d+)?) HTTP\/1\.1$/;
  assert.deepEqual(requestLines.filter((l) => !allowed.test(l)), [], "no other endpoint was ever called");
  assert.ok(requestLines.filter((l) => l.includes("/staple")).length >= visits, "a Staple refresh followed every visit");

  // The Gate's subscription names no visitor: no Diver id, no key id, no Signature-Agent host.
  const subscriptions = conns.filter((c) => /^GET \/v0\/revocations\/stream/.test(c));
  assert.ok(subscriptions.length >= 1, "the Gate subscribed");
  const visitor = [store.diver_id, store.session.kid, new URL(store.signature_agent).host, ...SITES.map((s) => s.host)];
  for (const sub of subscriptions) for (const v of visitor) assert.ok(!sub.includes(v), `the subscription does not carry ${v}`);

  console.log(`PRIV-3: ${requestLines.length} requests, ${Buffer.byteLength(all, "latin1")} bytes to the Registry over ${visits} site visits; 0 canaries`);
});
