// GATE-5 (docs/MISSION.md §4): broken, the Gate still opens. Faults are injected into a real
// @ludion/gate-node on a real HTTP server, and every raw request is also sent to the same app
// without a Gate:
//   - Pressure 0–1: the app's own answer (status + body) for 100% of requests, and the Gate adds
//     no more than its timeout, whatever the resolver, the sink, the Registry keys, the clock or
//     the headers do.
//   - Pressure 2–3: a fault inside the Gate does what fail_mode says (closed → a denial with
//     Ludion-Error and a help Link; open → the app's answer). Key discovery failures are
//     UNVERIFIED and denied whatever fail_mode says: the requester picks the Signature-Agent, so a
//     tarpit must never fail open (ADR-020).
//   - Never a hang (a request slower than HANG_MS fails the suite), an unhandled rejection or an
//     uncaught exception.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey, createGate } from "@ludion/gate-core";
import { keypair, signed, staple, digestOf, AGENT, NOW_MS, REGISTRY_ISS } from "../../gate-core/test/support.mjs";

const TIMEOUT_MS = 400;   // the Gate's budget in this suite
const SLACK_MS = 350;     // scheduler jitter on shared CI runners
const HANG_MS = 8_000;    // slower than this is a hang

const crashes = [];
process.on("unhandledRejection", (e) => crashes.push(`unhandledRejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => crashes.push(`uncaughtException: ${e?.stack ?? e}`));

const agent = await keypair();
const registry = await keypair();
const noNetwork = async () => new Response("", { status: 404 });
const UA = { human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
  declared: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", suspected: "python-requests/2.32.3" };

// ── servers ────────────────────────────────────────────────────────────────────────────────
const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }))));
async function serve(handler) {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv.address().port;
}
const app = (req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/plain" }); res.end(`app ${req.method} ${req.url}`); };
const baselinePort = await serve(app);

/** A gated copy of the app. `patch(gate)` injects the fault after the Gate is built. */
async function gated(config = {}, { prime = true, patch } = {}) {
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({ siteId: "site-gate5", siteKey: siteKey.privateJwk, now: () => NOW_MS, timeoutMs: TIMEOUT_MS,
    resolver: { fetch: noNetwork }, ...config });
  if (prime) await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  patch?.(mw.gate);
  // A rejection from the middleware is deliberately left unhandled: it would show up in `crashes`.
  const port = await serve((req, res) => { mw(req, res, () => app(req, res)); });
  return { port, host: `127.0.0.1:${port}`, gate: mw.gate };
}

// ── raw HTTP ───────────────────────────────────────────────────────────────────────────────
/** Bytes on a fresh socket; resolves with the parsed response, or `hang`. */
function send(port, bytes) {
  return new Promise((resolve) => {
    const t0 = performance.now(), chunks = [];
    const sock = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => { sock.destroy(); resolve({ hang: true, ms: performance.now() - t0 }); }, HANG_MS);
    sock.on("data", (c) => chunks.push(c));
    sock.on("error", () => {});
    sock.on("close", () => { clearTimeout(timer); resolve({ ...parse(Buffer.concat(chunks)), ms: performance.now() - t0 }); });
    sock.write(bytes);
  });
}
function parse(buf) {
  const s = buf.toString("latin1"), i = s.indexOf("\r\n\r\n");
  if (i < 0) return { status: 0, headers: {}, body: s };
  const [statusLine, ...lines] = s.slice(0, i).split("\r\n");
  const headers = {};
  for (const l of lines) { const c = l.indexOf(":"); (headers[l.slice(0, c).trim().toLowerCase()] ??= []).push(l.slice(c + 1).trim()); }
  return { status: Number(statusLine.split(" ")[1]), headers, body: s.slice(i + 4) };
}
/** @param {{method?:string, path?:string, host:string, headers?:[string,string][], body?:string}} r */
function raw({ method = "GET", path = "/", host, headers = [], body }) {
  const lines = [`${method} ${path} HTTP/1.1`, ...(host === null ? [] : [`Host: ${host}`]), "Connection: close"];
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (body != null) lines.push(`Content-Length: ${Buffer.byteLength(body, "latin1")}`);
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), Buffer.from(body ?? "", "latin1")]);
}
const fieldsOf = (desc) => desc.fields.map((f) => [f.name, f.value]);

/** Requests of every kind the Gate treats differently, for a gated site at `host`. */
async function mixed(host, { withStaple } = {}) {
  const url = (p) => `http://${host}${p}`;
  const body = '{"sku":1}';
  const stp = withStaple ? await staple(registry, { jkt: agent.kid, depth: 2 }) : null;
  const sig = async (p, extra = {}) => signed({ key: agent, url: url(p), ...(stp ? { headers: { "ludion-staple": stp }, extraComponents: ["ludion-staple"] } : {}), ...extra });
  return [
    raw({ host, path: "/", headers: [["User-Agent", UA.human]] }),
    raw({ host, path: "/crit/1", headers: [["User-Agent", UA.declared]] }),
    raw({ host, path: "/crit/2", headers: [["User-Agent", UA.suspected]] }),
    raw({ host, path: "/crit/3", headers: fieldsOf(await sig("/crit/3")) }),
    raw({ host, path: "/page", headers: fieldsOf(await sig("/page")) }),
    raw({ host, method: "POST", path: "/crit/4", body, headers: fieldsOf(await sig("/crit/4", { method: "POST", body })) }),
  ];
}

// ── expectations ───────────────────────────────────────────────────────────────────────────
/** Every request gets exactly the app's answer, and the Gate adds at most its timeout. */
async function appAnswers(port, requests, label) {
  const problems = [];
  for (let i = 0; i < requests.length; i += 40) {
    await Promise.all(requests.slice(i, i + 40).map(async (bytes, j) => {
      const [base, got] = await Promise.all([send(baselinePort, bytes), send(port, bytes)]);
      const at = `${label} #${i + j}`;
      if (got.hang) problems.push(`${at}: hang`);
      else if (got.status !== base.status || got.body !== base.body) {
        problems.push(`${at}: ${got.status} ${JSON.stringify(got.body.slice(0, 60))} instead of the app's ${base.status} ${JSON.stringify(base.body.slice(0, 60))} (${got.headers["ludion-error"] ?? "no Ludion-Error"})`);
      } else if (got.ms - base.ms > TIMEOUT_MS + SLACK_MS) problems.push(`${at}: added ${Math.round(got.ms - base.ms)}ms > timeoutMs ${TIMEOUT_MS}`);
    }));
  }
  return problems;
}

/** A Gate denial: 4xx, Ludion-Error, Link rel="help", within the timeout. */
function isDenial(got) {
  return got.status >= 400 && got.status < 500 && got.headers["ludion-error"]?.length === 1
    && /^<https:\/\/ludion\.ai\/e\/[a-z_]+>; rel="help"$/.test(got.headers.link?.[0] ?? "");
}
async function denied(port, requests, label) {
  const problems = [];
  await Promise.all(requests.map(async (bytes, i) => {
    const got = await send(port, bytes);
    if (got.hang) problems.push(`${label} #${i}: hang`);
    else if (!isDenial(got)) problems.push(`${label} #${i}: ${got.status} ${JSON.stringify(got.body.slice(0, 60))}, not a Gate denial`);
    else if (got.ms > TIMEOUT_MS + SLACK_MS) problems.push(`${label} #${i}: denial took ${Math.round(got.ms)}ms > timeoutMs ${TIMEOUT_MS}`);
  }));
  return problems;
}

// ── faults ─────────────────────────────────────────────────────────────────────────────────
const never = () => new Promise(() => {});
const RESOLVER_FAULTS = {
  "resolver throws": () => { throw new Error("resolver exploded"); },
  "resolver rejects": async () => { throw new TypeError("resolver rejected"); },
  "resolver hangs forever": never,
  "resolver returns null": async () => null,
  "resolver returns junk": async () => ({ algorithm: 42, verify: "yes" }),
  "verifier throws": async () => ({ algorithm: "ed25519", keyid: agent.kid, verify: () => { throw new Error("verifier exploded"); } }),
  "verifier says maybe": async () => ({ algorithm: "ed25519", keyid: agent.kid, verify: async () => "maybe" }),
};
const FETCH_FAULTS = {
  "fetch throws": () => { throw new Error("fetch exploded"); },
  "fetch rejects": async () => { throw new Error("ECONNRESET"); },
  "fetch hangs, ignoring abort": never,
  "fetch returns null": async () => null,
  "fetch returns junk": async () => ({ status: 200, headers: { get: () => { throw new Error("junk"); } } }),
  "body never ends": async () => ({ status: 200, headers: new Headers(), arrayBuffer: never }),
  "body is not JSON": async () => new Response("<html>", { status: 200 }),
};
const patchResolver = (fault) => (gate) => { gate.resolver.resolve = fault; };

for (const pressure of [0, 1]) {
  test(`GATE-5: P${pressure} — resolver faults: the app answers every request within the timeout`, { timeout: 60_000 }, async () => {
    const problems = [];
    for (const [name, fault] of Object.entries(RESOLVER_FAULTS)) {
      const { port, host } = await gated({ pressure }, { patch: patchResolver(fault) });
      problems.push(...await appAnswers(port, await mixed(host), `P${pressure} ${name}`));
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — key fetch faults (real resolver, no pinned keys): the app answers within the timeout`, { timeout: 60_000 }, async () => {
    const problems = [];
    for (const [name, fetch] of Object.entries(FETCH_FAULTS)) {
      const { port, host } = await gated({ pressure, resolver: { fetch } }, { prime: false });
      problems.push(...await appAnswers(port, await mixed(host), `P${pressure} ${name}`));
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — sink throws, rejects or hangs: nothing changes and nothing waits for it`, { timeout: 60_000 }, async () => {
    const problems = [];
    const sinks = {
      "sink throws": () => { throw new Error("sink exploded"); },
      "sink rejects": async () => { throw new Error("sink rejected"); },
      "sink hangs forever": never,
    };
    for (const [name, sink] of Object.entries(sinks)) {
      let calls = 0;
      const { port, host } = await gated({ pressure, sink: (e) => { calls++; return sink(e); } });
      problems.push(...await appAnswers(port, await mixed(host), `P${pressure} ${name}`));
      if (!calls) problems.push(`P${pressure} ${name}: the sink was never called, so the fault was not exercised`);
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — Registry keys missing or unreadable: the Gate starts and the app answers`, { timeout: 60_000 }, async () => {
    const problems = [];
    const variants = {
      missing: undefined, empty: { keys: [] }, "keys not a list": { keys: "nope" }, "a string": "garbage",
      "junk members": { keys: [null, "x", 7, { kty: "OKP", crv: "Ed25519" }, { kty: "OKP", crv: "Ed25519", x: "!!!" }] },
    };
    for (const [name, registryKeys] of Object.entries(variants)) {
      const { port, host, gate } = await gated({ pressure, registryKeys, registryIssuer: REGISTRY_ISS });
      if (!["none", "unusable"].includes(gate.health.registryKeys)) problems.push(`${name}: health says ${gate.health.registryKeys}`);
      problems.push(...await appAnswers(port, await mixed(host, { withStaple: true }), `P${pressure} registry keys ${name}`));
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — the clock fails: the app answers, even with failMode "closed"`, { timeout: 60_000 }, async () => {
    const problems = [];
    for (const [name, broken] of Object.entries({ "clock throws": () => { throw new Error("clock"); }, "clock is NaN": () => NaN })) {
      let fault = false;
      const { port, host } = await gated({ pressure, failMode: "closed", now: () => (fault ? broken() : NOW_MS) });
      const requests = await mixed(host);
      fault = true;
      problems.push(...await appAnswers(port, requests, `P${pressure} ${name}`));
    }
    assert.deepEqual(problems, []);
  });
}

// ── fuzzed headers ─────────────────────────────────────────────────────────────────────────
function prng(seed) { // mulberry32: reproducible fuzz, the seed is in the failure message
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FUZZ_FIELDS = ["Signature", "Signature-Input", "Signature-Agent", "Ludion-Staple", "Ludion-Mandate"];
const BREAKERS = ["sig1=(", "sig1=:!!!:", "=", ",", ";", "sig1=(\"@authority\";key=)", "sig1=\"unterminated", "sig1=((", "sig1=:=:",
  "sig1=();created=99999999999999999999", "sig1=();created=-1;expires=-2", "sig1=(\"@query-param\";name=)", "sig1=(\"signature-agent\";key=\"nope\")",
  "a=1, ".repeat(400), "sig1=:" + "A".repeat(6000) + ":", "sig1=(" + "\"@method\" ".repeat(300) + ")", "x.y.z", "...", "eyJ.eyJ.", "ÿþ", "sig1=?1"];
// Weighted so that most requests get past Node's own parser (control bytes, oversized headers and
// a missing Host are answered 400/431 by Node before any middleware runs, identically with and
// without the Gate) and reach the Gate.
const KINDS = [["printable", 6], ["obs-text", 3], ["control", 1], ["breaker", 6], ["mutated", 6], ["huge", 1], ["real", 3]];
function fuzzValue(rnd, real) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const len = Math.floor(rnd() * 200);
  let r = rnd() * KINDS.reduce((n, [, w]) => n + w, 0), kind = KINDS[0][0];
  for (const [k, w] of KINDS) { if ((r -= w) < 0) { kind = k; break; } }
  switch (kind) {
    case "printable": return Array.from({ length: len }, () => String.fromCharCode(0x20 + Math.floor(rnd() * 95))).join("");
    case "obs-text": return Array.from({ length: len }, () => String.fromCharCode(0x21 + Math.floor(rnd() * 222))).join("");
    case "control": return Array.from({ length: len }, () => String.fromCharCode(Math.floor(rnd() * 32))).join("");
    case "breaker": return pick(BREAKERS);
    case "mutated": { const v = real ?? pick(BREAKERS); const i = Math.floor(rnd() * v.length); return v.slice(0, i) + String.fromCharCode(0x21 + Math.floor(rnd() * 94)) + v.slice(i + 1); }
    case "huge": return "x".repeat(pick([8_000, 12_000, 20_000]));
    default: return real ?? "";
  }
}
const HOSTS = (h) => [h, h, h, h, h, h, "a b", "", "[::1", "x:99999", "evil.example", "%00", null];
const PATHS = ["/", "/crit/1", "/login", "/api/x?q=1", "/a/../crit/2", "//crit/3", "/crit/%2e%2e/x"];

async function fuzzRequests(host, seed, n) {
  const rnd = prng(seed), pick = (a) => a[Math.floor(rnd() * a.length)];
  const real = await signed({ key: agent, url: `http://${host}/crit/1`, headers: { "ludion-staple": "eyJhbGciOiJFZERTQSJ9.e30.AAAA" }, extraComponents: ["ludion-staple"] });
  const realOf = (name) => real.fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.value;
  const out = [];
  for (let i = 0; i < n; i++) {
    const headers = [["User-Agent", pick([UA.human, UA.declared, UA.suspected, "ExampleAgent/1.0"])]];
    for (const name of FUZZ_FIELDS) {
      if (rnd() < 0.55) continue;
      const copies = rnd() < 0.2 ? 2 + Math.floor(rnd() * 4) : 1; // duplicates
      for (let c = 0; c < copies; c++) headers.push([rnd() < 0.1 ? name.toLowerCase() : name, fuzzValue(rnd, realOf(name))]);
    }
    const method = pick(["GET", "GET", "POST", "PUT", "DELETE", "HEAD"]);
    const body = method === "POST" || method === "PUT" ? "{\"canary\":1}" : undefined;
    if (body && rnd() < 0.5) headers.push(["Content-Digest", rnd() < 0.5 ? digestOf(body) : fuzzValue(rnd)]);
    out.push(raw({ method, path: pick(PATHS), host: pick(HOSTS(host)), headers, body }));
  }
  return out;
}

for (const pressure of [0, 1]) {
  test(`GATE-5: P${pressure} — 400 fuzzed Signature / Signature-Input / Signature-Agent / Staple / Mandate headers: the app answers every one`, { timeout: 120_000 }, async () => {
    const seed = 0x6a7e5 + pressure;
    const { port, host } = await gated({ pressure, registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS });
    assert.deepEqual(await appAnswers(port, await fuzzRequests(host, seed, 400), `P${pressure} fuzz seed ${seed}`), []);
  });
}

// ── Pressure 2–3: fail_mode ────────────────────────────────────────────────────────────────
const CRIT = (p) => [{ match: "/crit/**", pressure: p, require: { depth: 1 } }];
/** Gate faults: the fault is the Gate's own (clock, in-Gate verification hang, Registry keys). */
async function gateFaults(pressure, failMode) {
  const cases = [];
  for (const [name, broken] of Object.entries({ "clock throws": () => { throw new Error("clock"); }, "clock is NaN": () => NaN })) {
    let fault = false;
    const g = await gated({ routes: CRIT(pressure), failMode, now: () => (fault ? broken() : NOW_MS) });
    const reqs = [raw({ host: g.host, path: "/crit/1", headers: fieldsOf(await signed({ key: agent, url: `http://${g.host}/crit/1` })) })];
    fault = true;
    cases.push({ name, port: g.port, reqs });
  }
  {
    const g = await gated({ routes: CRIT(pressure), failMode }, { patch: patchResolver(async () => ({ algorithm: "ed25519", keyid: agent.kid, verify: never })) });
    cases.push({ name: "verification hangs inside the Gate", port: g.port, reqs: [raw({ host: g.host, path: "/crit/2", headers: fieldsOf(await signed({ key: agent, url: `http://${g.host}/crit/2` })) })] });
  }
  for (const [name, registryKeys] of Object.entries({ "Registry keys missing": undefined, "Registry keys unreadable": { keys: [{ kty: "OKP", crv: "Ed25519", x: "!!!" }] } })) {
    const g = await gated({ routes: CRIT(pressure), failMode, registryKeys, registryIssuer: REGISTRY_ISS });
    const stp = await staple(registry, { jkt: agent.kid, depth: 2 });
    const desc = await signed({ key: agent, url: `http://${g.host}/crit/3`, headers: { "ludion-staple": stp }, extraComponents: ["ludion-staple"] });
    cases.push({ name, port: g.port, reqs: [raw({ host: g.host, path: "/crit/3", headers: fieldsOf(desc) })] });
  }
  return cases;
}

const MODES = [
  { failMode: undefined, expect: "closed" }, { failMode: "closed", expect: "closed" }, { failMode: "open", expect: "open" },
  { failMode: { pressure_0_1: "open", pressure_2_3: "open" }, expect: "open" }, { failMode: { pressure_2_3: "closed" }, expect: "closed" },
];
for (const pressure of [2, 3]) {
  test(`GATE-5: P${pressure} — faults inside the Gate do exactly what fail_mode says`, { timeout: 60_000 }, async () => {
    const problems = [];
    for (const { failMode, expect } of MODES) {
      for (const c of await gateFaults(pressure, failMode)) {
        const label = `P${pressure} failMode ${JSON.stringify(failMode)} ${c.name}`;
        problems.push(...(expect === "open" ? await appAnswers(c.port, c.reqs, label) : await denied(c.port, c.reqs, label)));
      }
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — key discovery failures are UNVERIFIED and denied even with failMode "open" (no tarpit bypass)`, { timeout: 60_000 }, async () => {
    const problems = [];
    const faults = { ...Object.fromEntries(Object.entries(RESOLVER_FAULTS).filter(([n]) => n.startsWith("resolver"))) };
    for (const [name, fault] of Object.entries(faults)) {
      const g = await gated({ routes: CRIT(pressure), failMode: "open" }, { patch: patchResolver(fault) });
      problems.push(...await denied(g.port, [raw({ host: g.host, path: "/crit/1", headers: fieldsOf(await signed({ key: agent, url: `http://${g.host}/crit/1` })) })], `P${pressure} ${name}`));
    }
    for (const [name, fetch] of Object.entries(FETCH_FAULTS)) {
      const g = await gated({ routes: CRIT(pressure), failMode: "open", resolver: { fetch } }, { prime: false });
      problems.push(...await denied(g.port, [raw({ host: g.host, path: "/crit/1", headers: fieldsOf(await signed({ key: agent, url: `http://${g.host}/crit/1` })) })], `P${pressure} ${name}`));
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — humans are untouched by Gate faults, whatever fail_mode says`, { timeout: 60_000 }, async () => {
    const problems = [];
    for (const { failMode } of MODES) {
      let fault = false;
      const g = await gated({ routes: CRIT(pressure), failMode, sink: never, now: () => (fault ? (() => { throw new Error("clock"); })() : NOW_MS) },
        { patch: patchResolver(never) });
      fault = true;
      problems.push(...await appAnswers(g.port, [raw({ host: g.host, path: "/crit/1", headers: [["User-Agent", UA.human], ["Cookie", "sid=1"]] })], `P${pressure} ${JSON.stringify(failMode)}`));
    }
    assert.deepEqual(problems, []);
  });

  test(`GATE-5: P${pressure} — 400 fuzzed headers: every answer is the app's or a Gate denial with Ludion-Error + help Link`, { timeout: 120_000 }, async () => {
    const problems = [];
    for (const failMode of ["closed", "open"]) {
      const seed = 0x6a7e5 + pressure * 10 + (failMode === "open" ? 1 : 0);
      const g = await gated({ routes: CRIT(pressure), failMode, registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS });
      const reqs = await fuzzRequests(g.host, seed, 400);
      for (let i = 0; i < reqs.length; i += 40) {
        await Promise.all(reqs.slice(i, i + 40).map(async (bytes, j) => {
          const [base, got] = await Promise.all([send(baselinePort, bytes), send(g.port, bytes)]);
          const at = `P${pressure} ${failMode} seed ${seed} #${i + j}`;
          if (got.hang) problems.push(`${at}: hang`);
          else if (got.status >= 500) problems.push(`${at}: ${got.status}`);
          else if (!(got.status === base.status && got.body === base.body) && !isDenial(got)) problems.push(`${at}: ${got.status} ${JSON.stringify(got.body.slice(0, 60))} is neither the app's answer nor a Gate denial`);
          else if (got.ms - base.ms > TIMEOUT_MS + SLACK_MS) problems.push(`${at}: added ${Math.round(got.ms - base.ms)}ms`);
        }));
      }
    }
    assert.deepEqual(problems, []);
  });
}

// ── configuration and core ─────────────────────────────────────────────────────────────────
test("GATE-5: a fail_mode that would block Pressure 0–1, or a typo, is refused at startup", async () => {
  const siteKey = (await generateSiteKey()).privateJwk;
  for (const failMode of [{ pressure_0_1: "closed" }, "closd", { pressure_2_3: "shut" }, ["open"], 1]) {
    await assert.rejects(createGate({ siteId: "s", siteKey, failMode }), TypeError, `failMode ${JSON.stringify(failMode)}`);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) await assert.rejects(createGate({ siteId: "s", siteKey, timeoutMs }), TypeError);
});

test("GATE-5: the core never throws: a descriptor the adapter could not build still gets a fail_mode answer", async () => {
  const siteKey = (await generateSiteKey()).privateJwk;
  for (const failMode of ["closed", "open"]) {
    const gate = await createGate({ siteId: "s", siteKey, failMode, routes: CRIT(2) });
    for (const req of [undefined, null, {}, { targetUri: 42 }, { targetUri: "http://h/crit/1" }, { targetUri: "http://h/crit/1", fields: "x", method: "GET" },
      { targetUri: "::", method: "GET", fields: [] }, { targetUri: "http://a b/crit/1", method: "GET", fields: [{ name: "user-agent", value: UA.suspected }] }]) {
      const r = await gate.inspect(req);
      assert.ok(r?.decision?.action, `no decision for ${JSON.stringify(req)}`);
    }
    // A broken Host must not move the request off its route: /crit/1 stays a Pressure 2 route.
    const r = await gate.inspect({ targetUri: "http://a b/crit/1", method: "GET", fields: [{ name: "user-agent", value: UA.suspected }] });
    assert.equal(r.route.pressure, 2);
    assert.equal(r.decision.action, "deny");
  }
});

test("GATE-5: a resolver that says anything but a real `true` never verifies; one whose fetch ignores abort still times out", async () => {
  const siteKey = (await generateSiteKey()).privateJwk;
  // The resolver's own deadline, not just the Gate's budget: a hung fetch must settle, so the
  // negative cache fills and the next request for that directory is answered at once.
  for (const [name, fetch] of [["fetch ignores abort", never], ["body never ends", FETCH_FAULTS["body never ends"]]]) {
    const g = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, timeoutMs: 5_000, resolver: { fetch, timeoutMs: 150 } });
    const t0 = performance.now();
    const first = await g.inspect(await signed({ key: agent, url: "https://shop.example/x" }));
    assert.equal(first.cls.class, "UNVERIFIED", name);
    assert.ok(performance.now() - t0 < 150 + SLACK_MS, `${name}: resolver took ${Math.round(performance.now() - t0)}ms with a 150ms fetch timeout`);
    assert.equal(g.resolver.stats().inflight, 0, `${name}: the hung fetch is still in flight`);
  }
  const gate = await createGate({ siteId: "s", siteKey, now: () => NOW_MS });
  let r;
  for (const answer of ["maybe", 1, {}, [true]]) {
    gate.resolver.resolve = async () => ({ algorithm: "ed25519", keyid: agent.kid, verify: async () => answer, identifier: AGENT });
    r = await gate.inspect(await signed({ key: agent, url: "https://shop.example/y" }));
    assert.notEqual(r.cls.class, "VERIFIED", `verify() answered ${JSON.stringify(answer)}`);
  }
});

test("GATE-5: no unhandled rejection and no uncaught exception anywhere in the suite", async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(crashes, []);
});
