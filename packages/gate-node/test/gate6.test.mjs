// GATE-6 (docs/MISSION.md §4): key discovery never reaches the site's own network. A sandbox:
//   - an internal service (TCP on 127.0.0.1 and ::1) that counts every connection it receives;
//   - "the internet": one public address (PUBLIC_IP) that the test's dial seam routes to a local
//     raw-socket simulator, which records the exact bytes it is sent;
//   - DNS under the test's control (resolver.lookup), including answers that change (rebinding).
// Through the real @ludion/gate-node Gate: every private / loopback / link-local / CGNAT /
// multicast / reserved address, every IPv6 form of one, every local name, plain http, every
// redirect, huge, endless, slow, compressed and bomb-shaped responses, and DNS rebinding. The
// internal service must receive 0 connections, nothing non-public may ever be dialled, and the
// zero-config Gate must be just as safe. Also the complement of PRIV-1/2 for this transport: the
// bytes on the wire are a bare GET with no request data in them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import zlib from "node:zlib";
import { ludionGate, createSafeFetch } from "@ludion/gate-node";
import { generateSiteKey, isPublicAddress } from "@ludion/gate-core";
import { keypair, signed } from "../../gate-core/test/support.mjs";

const PUBLIC_IP = "93.184.215.14";
const T0 = 1_800_000_000_000;
let t = T0;
const agent = await keypair();

// ── observation ────────────────────────────────────────────────────────────────────────────
const internal = { hits: 0 };
const closers = [];
after(() => { for (const c of closers) c(); });
async function listen(server, host) {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, host, ok); });
  closers.push(() => server.close());
  return server.address().port;
}
const INT = await listen(net.createServer((s) => { internal.hits++; s.destroy(); }), "127.0.0.1");
let INT6 = INT;
try { INT6 = await listen(net.createServer((s) => { internal.hits++; s.destroy(); }), "::1"); } catch { /* no IPv6 loopback here */ }

/** Every connection the process starts (backstop: nothing may connect to a non-public address but the simulator). */
const attempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const o = args[0] && typeof args[0] === "object" ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] };
  if (o && !o.path) attempts.push({ host: o.host ?? "localhost", port: Number(o.port) });
  return realConnect.apply(this, args);
};
after(() => { net.Socket.prototype.connect = realConnect; });

// ── the internet: a raw simulator behind PUBLIC_IP ─────────────────────────────────────────
const wire = [];
const TOTAL = 10 * 1024 * 1024;
const directory = JSON.stringify({ keys: [{ ...agent.publicJwk, use: "sig" }] });
const sent = { chunked: 0 };
function head(status, headers) {
  return `HTTP/1.1 ${status} X\r\n${Object.entries({ connection: "close", ...headers }).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
}
const REDIRECT_TO = [`http://127.0.0.1:${INT}/keys`, `https://169.254.169.254/latest/meta-data/`, `http://[::1]:${INT6}/keys`, `http://loop.test/keys`];
/** The simulator serves by Host: `<behaviour>.sim.test`; any other host gets a real directory. */
function respond(sock, path, host) {
  const json = (body, extra = {}) => sock.end(head(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "max-age=60", ...extra }) + body);
  const behaviour = host.endsWith(".sim.test") ? `/${host.slice(0, -".sim.test".length)}` : path;
  const r = /^\/r(30[1278]|303)(?:-(\d))?$/.exec(behaviour);
  if (r) return sock.end(head(Number(r[1]), { location: REDIRECT_TO[Number(r[2] ?? 0)], "content-length": 0 }));
  switch (behaviour) {
    case "/.well-known/http-message-signatures-directory": return json(directory, { "content-type": "application/http-message-signatures-directory+json" });
    case "/huge": return sock.end(head(200, { "content-type": "application/json", "content-length": TOTAL }) + " ".repeat(1024));
    case "/huge-chunked": {
      sock.write(head(200, { "content-type": "application/json", "transfer-encoding": "chunked" }));
      const chunk = `4000\r\n${" ".repeat(0x4000)}\r\n`;
      const pump = () => { while (sent.chunked < TOTAL) { sent.chunked += 0x4000; if (!sock.write(chunk)) return sock.once("drain", pump); } sock.end("0\r\n\r\n"); };
      return pump();
    }
    case "/slow": {
      sock.write(head(200, { "content-type": "application/json", "content-length": 5000 }));
      const iv = setInterval(() => { if (sock.destroyed) clearInterval(iv); else sock.write(" "); }, 100);
      sock.on("close", () => clearInterval(iv));
      return;
    }
    case "/bomb-keys": return json(JSON.stringify({ keys: Array.from({ length: 200 }, (_, i) => ({ kty: "OKP", crv: "Ed25519", x: `${i}`.padStart(43, "A"), use: "sig" })) }));
    case "/bomb-key": return json(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "A".repeat(50_000), use: "sig" }] }));
    case "/nested": return json(`${"[".repeat(30_000)}${"]".repeat(30_000)}`);
    case "/gzip": {
      const gz = zlib.gzipSync(`{"keys":[${" ".repeat(20 * 1024 * 1024)}]}`);
      return sock.end(Buffer.concat([Buffer.from(head(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": gz.length })), gz]));
    }
    default: return sock.end(head(404, { "content-length": 0 }));
  }
}
const SIM = await listen(net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("error", () => {});
  sock.on("data", function onData(d) {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    sock.off("data", onData);
    const raw = buf.toString("latin1");
    const [line] = raw.split("\r\n");
    const host = (/\r\nhost: *([^\r:]+)/i.exec(raw)?.[1] ?? "").toLowerCase();
    wire.push({ raw, line, host });
    respond(sock, line.split(" ")[1], host);
  });
}), "127.0.0.1");

/** Where a checked address is reached: PUBLIC_IP is the simulator; anything else is recorded and then dialled for real. */
const dialled = [];
const dial = (address, port) => { dialled.push(address); return address === PUBLIC_IP ? { host: "127.0.0.1", port: SIM } : { host: address, port }; };

// ── DNS ────────────────────────────────────────────────────────────────────────────────────
const lookups = new Map();
const PRIVATE_NAMES = {
  "loop.test": ["127.0.0.1"], "loop-other.test": ["127.53.0.1"], "ten.test": ["10.0.0.8"], "p172.test": ["172.20.1.1"], "p192.test": ["192.168.0.10"],
  "cgnat.test": ["100.100.100.200"], "metadata.test": ["169.254.169.254"], "zero.test": ["0.0.0.0"], "mcast.test": ["239.255.255.250"],
  "bench.test": ["198.18.0.5"], "reserved.test": ["240.0.0.1"], "bcast.test": ["255.255.255.255"], "loop6.test": ["::1"], "unspec6.test": ["::"],
  "ula.test": ["fd00:ec2::254"], "ll6.test": ["fe80::1"], "mapped.test": ["::ffff:127.0.0.1"], "mappedhex.test": ["::ffff:a9fe:a9fe"],
  "nat64.test": ["64:ff9b::a9fe:a9fe"], "sixtofour.test": ["2002:7f00:1::1"], "mcast6.test": ["ff02::1"], "sitelocal6.test": ["fec0::1"],
  "mixed.test": [PUBLIC_IP, "127.0.0.1"], "mixed6.test": [PUBLIC_IP, "fd00::1"],
};
const DNS = { ...PRIVATE_NAMES, "pub.test": [PUBLIC_IP] };
const SEQUENCES = { "rebind.test": [[PUBLIC_IP], ["127.0.0.1"]], "flip.test": [[PUBLIC_IP], ["127.0.0.1"], [PUBLIC_IP], ["127.0.0.1"]] };
function lookup(host, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const n = (lookups.get(host) ?? 0) + 1;
  lookups.set(host, n);
  const seq = SEQUENCES[host];
  const answer = seq ? seq[Math.min(n, seq.length) - 1] : host.endsWith(".sim.test") ? [PUBLIC_IP] : DNS[host];
  queueMicrotask(() => {
    if (!answer) return cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
    const all = answer.map((address) => ({ address, family: net.isIP(address) }));
    return options.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
  });
}

// ── gates ──────────────────────────────────────────────────────────────────────────────────
const siteKey = (await generateSiteKey()).privateJwk;
const routes = [{ match: "/checkout/**", pressure: 2 }];
const base = { siteId: "site-gate6", siteKey, now: () => t, timeoutMs: 800, routes };
const strict = await ludionGate({ ...base, resolver: { lookup, dial } });                              // https only
const lab = await ludionGate({ ...base, resolver: { lookup, dial, insecureAllowHttp: true } });        // the simulator speaks http
const zero = await ludionGate({ siteId: "site-gate6-zero", siteKey, now: () => t });                     // zero network config: real DNS, real connect

async function inspect(mw, agentHeader, extra = {}) {
  const req = await signed({ key: agent, agentHeader, created: Math.floor(t / 1000), url: "https://shop.example/checkout/1?q=ludioncanaryquery", headers: { cookie: "sid=ludioncanarycookie" }, ...extra });
  const t0 = performance.now();
  const r = await mw.gate.inspect(req, { ip: "203.0.113.9" });
  return { ...r, ms: performance.now() - t0 };
}
const nonPublicDials = () => dialled.filter((a) => !isPublicAddress(a));
function assertContained(label) {
  assert.equal(internal.hits, 0, `${label}: the internal service was reached`);
  assert.deepEqual(nonPublicDials(), [], `${label}: a non-public address was dialled`);
  const stray = attempts.filter((a) => a.port === INT || a.port === INT6 || (a.port !== SIM && !isPublicAddress(a.host)));
  assert.deepEqual(stray, [], `${label}: a connection to a non-public address was started`);
}

// ── the cases ──────────────────────────────────────────────────────────────────────────────
test("GATE-6: names that resolve to any non-public address are refused before connecting (each name was really looked up)", async () => {
  for (const name of Object.keys(PRIVATE_NAMES)) {
    const before = lookups.get(name) ?? 0;
    const r = await inspect(strict, `sig1="https://${name}"`);
    assert.equal(r.cls.class, "UNVERIFIED", `${name}: ${r.cls.class} ${r.cls.detail ?? ""}`);
    assert.equal(r.decision.action, "deny", `${name}: denied on the Pressure 2 route`);
    assert.ok((lookups.get(name) ?? 0) > before, `${name} was resolved through the Gate's lookup (the safe transport is in use)`);
    assertContained(name);
  }
});

test("GATE-6: the zero-config Node Gate refuses every non-public IP literal form and every local name without a connection", async () => {
  const literals = [`127.0.0.1:${INT}`, `127.1:${INT}`, `2130706433:${INT}`, `0x7f000001:${INT}`, `0177.0.0.1:${INT}`, `0.0.0.0:${INT}`,
    `[::1]:${INT6}`, `[::ffff:127.0.0.1]:${INT}`, `[::ffff:7f00:1]:${INT}`, `[::]:${INT}`, `[64:ff9b::7f00:1]:${INT}`, `[2002:7f00:1::1]:${INT}`,
    "169.254.169.254", "[fd00:ec2::254]", "10.0.0.1", "172.31.255.255", "192.168.1.1", "100.100.100.200", "198.18.0.1", "224.0.0.1", "255.255.255.255", "[fe80::1]", "[ff02::1]"];
  const names = [`localhost:${INT}`, `localhost.:${INT}`, `api.localhost:${INT}`, "metadata", "metadata.google.internal", "instance-data.ec2.internal", "printer.local", "router.home.arpa", "nas.lan"];
  for (const host of [...literals, ...names]) {
    const r = await inspect(zero, `sig1="https://${host}"`);
    assert.equal(r.cls.class, "UNVERIFIED", `${host}: ${r.cls.class} ${r.cls.detail ?? ""}`);
    assertContained(host);
  }
});

test("GATE-6: plain http is refused without touching the network", async () => {
  const before = wire.length, lk = lookups.get("pub.test") ?? 0;
  const r = await inspect(strict, `sig1="http://pub.test"`);
  assert.equal(r.cls.class, "UNVERIFIED");
  assert.equal(wire.length, before, "nothing was sent");
  assert.equal(lookups.get("pub.test") ?? 0, lk, "not even a DNS lookup");
  assertContained("http");
});

test("GATE-6: redirects (301, 302, 303, 307, 308) are never followed, wherever they point", async () => {
  for (const code of ["301", "302", "303", "307", "308"]) {
    for (let i = 0; i < REDIRECT_TO.length; i++) {
      const before = wire.length;
      const r = await inspect(lab, `sig1="http://r${code}-${i}.sim.test"`);
      assert.equal(r.cls.class, "UNVERIFIED", `${code} → ${REDIRECT_TO[i]}`);
      assert.equal(r.cls.reason, "status", `${code}: refused as a non-200 answer (${r.cls.detail})`);
      assert.equal(wire.length, before + 1, `${code}: exactly one request, to the redirecting server`);
      assertContained(`${code} → ${REDIRECT_TO[i]}`);
    }
  }
});

test("GATE-6: huge, endless, slow, compressed and bomb-shaped responses end bounded and UNVERIFIED", async () => {
  for (const behaviour of ["huge", "huge-chunked", "slow", "bomb-keys", "bomb-key", "nested", "gzip"]) {
    const before = wire.length;
    const r = await inspect(lab, `sig1="http://${behaviour}.sim.test"`);
    assert.equal(wire.length, before + 1, `${behaviour}: the simulator was really asked (${r.cls.detail})`);
    assert.equal(r.cls.class, "UNVERIFIED", `${behaviour}: ${r.cls.class} ${r.cls.detail ?? ""}`);
    assert.ok(r.ms < 800 + 400, `${behaviour}: bounded by the Gate's timeout (${Math.round(r.ms)}ms)`);
    assertContained(behaviour);
  }
  assert.ok(sent.chunked > 0 && sent.chunked < TOTAL, `an endless body is not read to the end (${sent.chunked} of ${TOTAL} bytes written before the Gate hung up)`);
  const gz = await createSafeFetch({ lookup, dial })("http://gzip.sim.test/");
  const body = new Uint8Array(await gz.arrayBuffer());
  assert.ok(body.length < 64 * 1024 && body[0] === 0x1f && body[1] === 0x8b, "a compressed body is never inflated");
});

test("GATE-6: DNS rebinding — one resolution per fetch, the connection goes to the checked address, a later private answer is refused", async () => {
  const r1 = await inspect(lab, `sig1="http://rebind.test"`);
  assert.equal(r1.cls.class, "VERIFIED", "the public answer serves a real directory (the setup is honest)");
  assert.equal(lookups.get("rebind.test"), 1, "one lookup for one fetch");
  t += 10 * 60_000; // past the directory's max-age: the next request fetches again, and DNS now says 127.0.0.1
  await inspect(lab, `sig1="http://rebind.test"`);
  assert.equal(lookups.get("rebind.test"), 2, "the refetch resolved once more");
  assertContained("rebind");

  const r2 = await inspect(lab, `sig1="http://flip.test"`); // alternates public/private on every lookup
  assert.equal(r2.cls.class, "VERIFIED");
  assert.equal(lookups.get("flip.test"), 1, "checked and connected on the same single answer (a second lookup would have said 127.0.0.1)");
  assertContained("flip");
});

test("GATE-6: on the wire, key discovery is a bare GET: no request data, no body, no decompression", async () => {
  const before = wire.length;
  const r = await inspect(lab, `sig1="http://pub.test"`);
  assert.equal(r.cls.class, "VERIFIED");
  const got = wire.slice(before);
  assert.equal(got.length, 1);
  const [line, ...hs] = got[0].raw.split("\r\n\r\n")[0].split("\r\n");
  assert.equal(line, "GET /.well-known/http-message-signatures-directory HTTP/1.1");
  const names = hs.map((h) => h.slice(0, h.indexOf(":")).toLowerCase()).sort();
  assert.deepEqual(names, ["accept", "accept-encoding", "connection", "host", "user-agent"]);
  const header = (n) => hs.find((h) => h.toLowerCase().startsWith(`${n}:`)).slice(n.length + 1).trim();
  assert.equal(header("host"), "pub.test");
  assert.equal(header("accept-encoding"), "identity");
  assert.match(header("user-agent"), /^LudionGate\//);
  assert.equal(got[0].raw.split("\r\n\r\n")[1], "", "no body");
  assert.doesNotMatch(got[0].raw, /ludioncanary|203\.0\.113\.9|shop\.example|checkout/i, "nothing from the request being verified");
});

test("GATE-6: the internal service received 0 connections over the whole run, and nothing non-public was dialled", () => {
  assert.equal(internal.hits, 0);
  assert.deepEqual(nonPublicDials(), []);
  assert.ok(dialled.includes(PUBLIC_IP), "the public simulator was reached (the sandbox is live)");
});
