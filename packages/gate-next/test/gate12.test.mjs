// GATE-12 (±): the Next.js adapter's key discovery never reaches the site's own network (GATE-6
// held to @ludion/gate-next, the way GATE-6 holds @ludion/gate-node). The Signature-Agent URL is
// the requester's choice; Next 16 runs proxy.js on the Node runtime, so a name that resolves to
// loopback, a private range or the metadata address must not be dialled.
//   − The proxy as shipped (ludion.config.json only, nothing injected): for every name that resolves
//     to a non-public address, the internal service receives 0 connections and nothing non-public
//     is dialled; the request is not attributed and is refused on its Pressure 2 route.
//   + The same proxy fetches a public key directory and VERIFIES the agent; a DNS answer that
//     changes between the check and the connection (rebinding) has nothing to change.
// DNS is this process's own (dns.lookup, replaced for the test); "the internet" is one public
// address that the test routes to a local simulator, only where the adapter lets a test say so.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import { createNextGate } from "@ludion/gate-next/core";
import { isPublicAddress } from "@ludion/gate-core";
import { keypair, signed } from "../../gate-core/test/support.mjs";

const PUBLIC_IP = "93.184.215.14";
const agent = await keypair();
const closers = [];
after(() => { for (const c of closers) c(); });
async function listen(server, host) {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, host, ok); });
  closers.push(() => server.close());
  return server.address().port;
}

// ── the site's own network: an internal service that counts every connection ─────────────────
const internal = { hits: 0 };
const INT = await listen(net.createServer((s) => { internal.hits++; s.destroy(); }), "127.0.0.1");
let INT6 = INT;
try { INT6 = await listen(net.createServer((s) => { internal.hits++; s.destroy(); }), "::1"); } catch { /* no IPv6 loopback here */ }

// ── "the internet": a directory server reached only through the adapter's test seam ──────────
const directory = JSON.stringify({ keys: [{ ...agent.publicJwk, use: "sig" }] });
const wire = [];
const SIM = await listen(http.createServer((req, res) => {
  wire.push(req.headers.host);
  if (req.url === "/.well-known/http-message-signatures-directory") {
    res.writeHead(200, { "content-type": "application/http-message-signatures-directory+json", "cache-control": "max-age=60" });
    return res.end(directory);
  }
  res.writeHead(404).end();
}), "127.0.0.1");

/** Every connection the process starts: nothing may connect to a non-public address but the simulator. */
const attempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const o = args[0] && typeof args[0] === "object" ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] };
  if (o && !o.path) attempts.push({ host: o.host ?? "localhost", port: Number(o.port) });
  return realConnect.apply(this, args);
};
after(() => { net.Socket.prototype.connect = realConnect; });

// ── DNS: this process's resolver, replaced (the shipped adapter is given nothing) ────────────
const PRIVATE_NAMES = {
  "loop.test": ["127.0.0.1"], "loop6.test": ["::1"], "ten.test": ["10.0.0.8"], "p192.test": ["192.168.0.10"], "metadata.test": ["169.254.169.254"],
  "mapped.test": ["::ffff:127.0.0.1"], "ula.test": ["fd00:ec2::254"], "cgnat.test": ["100.100.100.200"], "mixed.test": [PUBLIC_IP, "127.0.0.1"],
};
const SEQUENCES = { "rebind.test": [[PUBLIC_IP], ["127.0.0.1"]] };
const lookups = new Map();
const realLookup = dns.lookup;
dns.lookup = function lookup(host, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  if (typeof options === "number") options = { family: options };
  const n = (lookups.get(host) ?? 0) + 1;
  lookups.set(host, n);
  const seq = SEQUENCES[host];
  const answer = seq ? seq[Math.min(n, seq.length) - 1] : host === "pub.test" ? [PUBLIC_IP] : PRIVATE_NAMES[host];
  if (!answer) return realLookup.call(dns, host, options, cb);
  queueMicrotask(() => {
    const all = answer.map((address) => ({ address, family: net.isIP(address) }));
    return options?.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
  });
};
after(() => { dns.lookup = realLookup; });

// ── the proxy ──────────────────────────────────────────────────────────────────────────────
const CONFIG = { site_id: "site-gate12", routes: [{ match: "/checkout/**", pressure: 2 }], authorities: ["shop.example"], timeout_ms: 1500 };
const next = () => new Response(null, { headers: { "x-middleware-next": "1" } });
const shipped = createNextGate({ next, loadConfig: async () => CONFIG, env: {} });

async function send(gate, agentHeader) {
  const desc = await signed({ key: agent, agentHeader, url: "https://shop.example/checkout/1", created: Math.floor(Date.now() / 1000) });
  return gate.proxy(new Request(desc.targetUri, { headers: Object.fromEntries(desc.fields.map((f) => [f.name, f.value])) }));
}
const nonPublic = () => attempts.filter((a) => a.port === INT || a.port === INT6 || (a.port !== SIM && !isPublicAddress(a.host)));

test("GATE-12: the shipped Next proxy never connects to a non-public address, whatever the Signature-Agent name resolves to", async () => {
  for (const name of Object.keys(PRIVATE_NAMES)) {
    const port = PRIVATE_NAMES[name][0] === "::1" ? INT6 : INT;
    const before = lookups.get(name) ?? 0;
    const res = await send(shipped, `sig1="https://${name}:${port}"`);
    assert.equal(res.status, 401, `${name}: refused on the Pressure 2 route (${res.status})`);
    assert.equal(res.headers.get("ludion-error"), "signature_required", `${name}: not attributed`);
    assert.ok((lookups.get(name) ?? 0) > before, `${name}: the name really was resolved (discovery was attempted)`);
    assert.equal(internal.hits, 0, `${name}: the internal service was reached`);
    assert.deepEqual(nonPublic(), [], `${name}: a connection to a non-public address was started`);
  }
  // IP literals and local names are refused before any resolution, as on every adapter.
  for (const host of [`127.0.0.1:${INT}`, `[::1]:${INT6}`, `localhost:${INT}`, "169.254.169.254", "metadata"]) {
    const res = await send(shipped, `sig1="https://${host}"`);
    assert.equal(res.status, 401, host);
  }
  assert.equal(internal.hits, 0);
  assert.deepEqual(nonPublic(), []);
});

test("GATE-12: the Next proxy fetches a public directory and VERIFIES; rebinding has nothing to rebind", async () => {
  // The only seam: where a checked public address is reached (the simulator), and http for it.
  const dial = (address, port) => (address === PUBLIC_IP ? { host: "127.0.0.1", port: SIM } : { host: address, port });
  const lab = createNextGate({ next, loadConfig: async () => CONFIG, env: {}, resolver: { dial, insecureAllowHttp: true } });
  let res = await send(lab, 'sig1="http://pub.test"');
  assert.equal(res.headers.get("x-middleware-next"), "1", `VERIFIED and through (${res.status} ${res.headers.get("ludion-error")})`);
  assert.ok(wire.includes("pub.test"), "the directory came from the public address");
  // First answer public, second loopback: the address that was checked is the one connected to.
  res = await send(lab, 'sig1="http://rebind.test"');
  assert.equal(internal.hits, 0, "rebinding reached the internal service");
  assert.deepEqual(nonPublic(), []);
  // The private names stay refused with the seam in place too.
  res = await send(lab, `sig1="http://loop.test:${INT}"`);
  assert.equal(res.status, 401);
  assert.equal(internal.hits, 0);
});
