// GATE-11 (±): the body a signature binds is the body the app gets. A state-changing request signs
// its Content-Digest (spec §10.4, RFC 9530); the Gate must hold that digest to the bytes that
// actually arrive, or a captured request can carry any other body under the same signature.
// Through the real adapters: gate-node on a real HTTP server (the app reads the body after the
// Gate, the ways Node apps do), gate-workers around a fetch handler, gate-next's proxy.
//   + the signed body reaches the app byte for byte, VERIFIED (sha-256 and sha-512, length-delimited
//     and chunked, slow uploads, bodies past the Gate's limit still delivered whole);
//   − the same headers with another body are never VERIFIED: SPOOFED, refused on a Pressure 2
//     route before the app runs, and only observed (class SPOOFED) on a Pressure 0 route. A body
//     the Gate could not check (too large, already read, an unknown digest) is never VERIFIED either.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { component } from "http-message-sig";
import { ludionGate } from "@ludion/gate-node";
import { withLudion, ludion } from "@ludion/gate-workers";
import { createNextGate } from "@ludion/gate-next/core";
import { generateSiteKey } from "@ludion/gate-core";
import { keypair, signed, digestOf, AGENT, NOW_MS } from "../../packages/gate-core/test/support.mjs";

const agent = await keypair();
const SIGNED = '{"sku":"cam-1","amount":100}';
const SWAPPED = '{"sku":"cam-1","amount":900}';
const LONGER = '{"sku":"cam-1","amount":100,"ship_to":"elsewhere"}';
const ROUTES = [{ match: "/checkout/**", pressure: 2 }];
const headersOf = (desc) => Object.fromEntries(desc.fields.map((f) => [f.name, f.value]));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const COMPONENTS = ["@authority", component("signature-agent", { key: "sig1" }), "@method", "@path", "content-digest"];
const directory = JSON.stringify({ keys: [{ ...agent.publicJwk, use: "sig" }] });

// ── Node: a real server, the Gate first, the app reading the body afterwards ─────────────────
const node = { app: 0 };
let self;
const mw = await ludionGate({
  siteId: "site-gate11", siteKey: (await generateSiteKey()).privateJwk, routes: ROUTES, now: () => NOW_MS,
  authorities: (a) => a === self, resolver: { fetch: async () => new Response("", { status: 404 }) },
});
await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });

/** The ways a Node app (or its body parser) reads a request body once the Gate called next(). */
const READERS = {
  data: (req) => new Promise((ok, fail) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); req.on("error", fail); }),
  iterate: async (req) => { const c = []; for await (const d of req) c.push(d); return Buffer.concat(c); },
  pipe: (req) => new Promise((ok, fail) => { const c = []; req.pipe(new Writable({ write(d, _e, cb) { c.push(d); cb(); }, final(cb) { ok(Buffer.concat(c)); cb(); } })); req.on("error", fail); }),
  late: async (req) => { await new Promise((r) => setTimeout(r, 30)); return READERS.data(req); },
};
const srv = http.createServer(async (req, res) => {
  const reader = new URL(req.url, "http://x").searchParams.get("read") ?? "data";
  // A body parser that ran before the Gate (the Gate is not first): the body is gone when it looks.
  const pre = req.url.includes("pre=1") ? await READERS.data(req) : null;
  mw(req, res, async () => {
    node.app++;
    const body = pre ?? await READERS[reader](req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ class: req.ludion.cls.class, reason: req.ludion.cls.reason ?? null, sha: sha(body), length: body.length, text: body.length < 4096 ? body.toString("utf8") : null }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
after(() => srv.close());
self = `127.0.0.1:${srv.address().port}`;
const ORIGIN = `http://${self}`;

/** Send `headers` with `body` (any bytes, any pacing) and read the answer. */
function send(path, headers, body, { chunked = false, pieces = 1, gapMs = 0, mayReset = false } = {}) {
  return new Promise((ok, fail) => {
    const h = { ...headers };
    delete h["content-length"];
    if (chunked) h["transfer-encoding"] = "chunked"; else h["content-length"] = Buffer.byteLength(body);
    // One connection per request: a refusal answered before the upload ends must not leave a
    // half-written body on a kept-alive socket for the next request.
    let answered = false;
    const req = http.request(`${ORIGIN}${path}`, { method: "POST", headers: h, agent: false }, (res) => {
      answered = true;
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => {
        const text = Buffer.concat(c).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        ok({ status: res.statusCode, error: res.headers["ludion-error"], json });
      });
    });
    // After an early refusal the rest of the upload may be cut off; with `mayReset`, even before the answer is read.
    req.on("error", (e) => { if (answered) return; if (mayReset && e.code === "ECONNRESET") ok({ status: 0, reset: true }); else fail(e); });
    const buf = Buffer.from(body);
    const size = Math.max(1, Math.ceil(buf.length / pieces));
    (async () => {
      for (let i = 0; i < buf.length && !req.destroyed; i += size) { req.write(buf.subarray(i, i + size)); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); }
      if (!req.destroyed) req.end();
    })();
  });
}
const signedFor = (path, body, extra = {}) => signed({ key: agent, method: "POST", url: `${ORIGIN}${path}`, body, ...extra });

test("GATE-11: Node — the signed body reaches the app byte for byte and VERIFIED, however the app reads it", async () => {
  for (const reader of Object.keys(READERS)) {
    const path = `/checkout/pay?read=${reader}`;
    const before = node.app;
    const r = await send(path, headersOf(await signedFor(path, SIGNED)), SIGNED);
    assert.equal(r.status, 200, `${reader}: ${r.error ?? ""}`);
    assert.equal(r.json.class, "VERIFIED", `${reader}: ${r.json.reason}`);
    assert.equal(r.json.text, SIGNED, `${reader}: the app got the signed bytes`);
    assert.equal(node.app, before + 1);
  }
  // chunked, and an upload that arrives in slow pieces
  const path = "/checkout/pay?read=data";
  for (const opts of [{ chunked: true, pieces: 4 }, { pieces: 6, gapMs: 40 }]) {
    const r = await send(path, headersOf(await signedFor(path, SIGNED)), SIGNED, opts);
    assert.equal(r.json?.class, "VERIFIED", JSON.stringify(opts));
    assert.equal(r.json.text, SIGNED);
  }
  // sha-512 (RFC 9530 lists both), and both at once
  const sha512 = `sha-512=:${createHash("sha512").update(SIGNED).digest("base64")}:`;
  for (const digest of [sha512, `${digestOf(SIGNED)}, ${sha512}`]) {
    const desc = await signed({ key: agent, method: "POST", url: `${ORIGIN}${path}`, headers: { "content-digest": digest }, components: COMPONENTS });
    const r = await send(path, headersOf(desc), SIGNED);
    assert.equal(r.json?.class, "VERIFIED", digest);
  }
});

test("GATE-11: Node — the same headers with another body are SPOOFED, and refused before the app on Pressure 2", async () => {
  const path = "/checkout/pay?read=data";
  for (const other of [SWAPPED, LONGER, "", `${SIGNED} `]) {
    const before = node.app;
    const r = await send(path, headersOf(await signedFor(path, SIGNED)), other);
    assert.equal(r.status, 401, `body ${JSON.stringify(other)}: ${r.status}`);
    assert.equal(r.error, "invalid_signature");
    assert.equal(node.app, before, "the app never ran");
  }
  // Pressure 0 observes: the app runs, and is told the request is a spoof, never VERIFIED.
  const obs = "/orders?read=data";
  const r = await send(obs, headersOf(await signedFor(obs, SIGNED)), SWAPPED);
  assert.equal(r.status, 200);
  assert.equal(r.json.class, "SPOOFED");
  assert.equal(r.json.text, SWAPPED, "observing never changes what the app receives");
  // One sha-256 that matches does not excuse a sha-512 that does not.
  const wrong512 = `sha-512=:${createHash("sha512").update(SWAPPED).digest("base64")}:`;
  const both = await signed({ key: agent, method: "POST", url: `${ORIGIN}${path}`, headers: { "content-digest": `${digestOf(SIGNED)}, ${wrong512}` }, components: COMPONENTS });
  assert.equal((await send(path, headersOf(both), SIGNED)).status, 401, "every digest the Gate knows must match");
});

test("GATE-11: Node — a body the Gate could not check is never VERIFIED, and still reaches the app whole", async () => {
  // Past the Gate's body limit: not checked, so not VERIFIED; the app still gets every byte.
  const big = `{"blob":"${"x".repeat(3 * 1024 * 1024)}"}`;
  const obs = "/orders?read=data";
  let r = await send(obs, headersOf(await signedFor(obs, big)), big, { pieces: 8 });
  assert.equal(r.status, 200);
  assert.notEqual(r.json.class, "VERIFIED", "an unchecked body is not attributable");
  assert.equal(r.json.sha, sha(big), "the app received the whole body");
  assert.equal(r.json.length, Buffer.byteLength(big));
  // On Pressure 2 it is refused before the app runs: the 401 is sent before the upload ends, so the
  // client may see the connection close before it reads the answer. The app count is the proof.
  const path = "/checkout/pay?read=data";
  const before = node.app;
  r = await send(path, headersOf(await signedFor(path, big)), big, { pieces: 8, mayReset: true });
  assert.ok(r.reset || r.status === 401, `refused (${r.status})`);
  assert.equal(node.app, before, "and on Pressure 2 the app never runs");
  // Read before the Gate saw it: nothing left to check.
  r = await send("/orders?pre=1", headersOf(await signedFor("/orders?pre=1", SIGNED)), SIGNED);
  assert.notEqual(r.json.class, "VERIFIED");
  // Only digests the Gate does not implement (RFC 9530 deprecates these): nothing checked.
  for (const digest of [`md5=:${createHash("md5").update(SIGNED).digest("base64")}:`, "unixsum=:AAAA:", "sha-256=:not base64!:", "sha-256"]) {
    const desc = await signed({ key: agent, method: "POST", url: `${ORIGIN}${obs}`, headers: { "content-digest": digest }, components: COMPONENTS });
    r = await send(obs, headersOf(desc), SIGNED);
    assert.notEqual(r.json?.class, "VERIFIED", digest);
  }
});

// ── Workers and Next: Web Requests ─────────────────────────────────────────────────────────
const SITE = "https://shop.example";
async function webRequest(path, body, sentBody = body) {
  // These adapters run on the real clock (their config carries none).
  const desc = await signed({ key: agent, method: "POST", url: `${SITE}${path}`, body, created: Math.floor(Date.now() / 1000) });
  return new Request(`${SITE}${path}`, { method: "POST", headers: headersOf(desc), body: sentBody });
}

test("GATE-11: Workers — the handler gets the signed body VERIFIED; another body is SPOOFED and refused on Pressure 2", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).startsWith(AGENT)
    ? new Response(directory, { headers: { "content-type": "application/http-message-signatures-directory+json" } })
    : new Response("", { status: 404 }));
  try {
    const seen = [];
    const w = withLudion({ async fetch(request) { seen.push({ class: ludion(request)?.cls.class, text: await request.text() }); return new Response("ok"); } });
    const env = { LUDION: { site_id: "site-gate11-workers", routes: ROUTES, authorities: ["shop.example"] } };
    const ctx = { waitUntil() {} };
    let res = await w.fetch(await webRequest("/checkout/pay", SIGNED), env, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(seen.pop(), { class: "VERIFIED", text: SIGNED });
    for (const other of [SWAPPED, LONGER]) {
      res = await w.fetch(await webRequest("/checkout/pay", SIGNED, other), env, ctx);
      assert.equal(res.status, 401, other);
      assert.equal(res.headers.get("ludion-error"), "invalid_signature");
    }
    assert.equal(seen.length, 0, "the handler never ran for a swapped body");
    res = await w.fetch(await webRequest("/orders", SIGNED, SWAPPED), env, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(seen.pop(), { class: "SPOOFED", text: SWAPPED });
  } finally { globalThis.fetch = realFetch; }
});

test("GATE-11: Next — the proxy passes the signed body on untouched; another body is refused on Pressure 2", async () => {
  const next = () => new Response(null, { headers: { "x-middleware-next": "1" } });
  const g = createNextGate({ next, loadConfig: async () => ({ site_id: "site-gate11-next", routes: ROUTES, authorities: ["shop.example"] }), env: {} });
  const warm = await g.proxy(new Request(`${SITE}/`, { headers: { "user-agent": "curl/8" } })); // builds the Gate
  assert.equal(warm.headers.get("x-middleware-next"), "1");
  await (await g.gate).resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  const good = await webRequest("/checkout/pay", SIGNED);
  let res = await g.proxy(good);
  assert.equal(res.headers.get("x-middleware-next"), "1", `continued (${res.status} ${res.headers.get("ludion-error")})`);
  assert.equal(await good.text(), SIGNED, "the route handler still gets the body");
  for (const other of [SWAPPED, LONGER]) {
    res = await g.proxy(await webRequest("/checkout/pay", SIGNED, other));
    assert.equal(res.status, 401, other);
    assert.equal(res.headers.get("ludion-error"), "invalid_signature");
  }
});
