// GATE-7 cross-site replay, pinned from both sides (ADR-023). A signature covers @authority, and
// the Gate reads the authority from the request it received, so a site that does not know its
// own authorities cannot tell a signature made for it from one captured at another site and
// replayed here with that site's Host. Found on a real gate-node server: before the fix a POST
// /checkout signed for shop-a.example was VERIFIED and served on shop-b's Pressure 2 route.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ludionGate } from "@ludion/gate-node";
import { createGate, generateSiteKey, createAuthorities, requestAuthority } from "@ludion/gate-core";
import { keypair, signed, NOW_MS, AGENT } from "../../gate-core/test/support.mjs";

const agent = await keypair();
const directory = { keys: [{ ...agent.publicJwk, use: "sig" }] };
let fetches = 0;
const fetch = async () => { fetches++; return new Response(JSON.stringify(directory), { headers: { "content-type": "application/http-message-signatures-directory+json" } }); };
const siteKey = (await generateSiteKey()).privateJwk;
const ROUTES = [{ match: "/checkout/**", pressure: 2 }];
const UA_HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
async function shop(config) {
  const mw = await ludionGate({ siteId: "site-b", siteKey, now: () => NOW_MS, routes: ROUTES, resolver: { fetch }, ...config });
  let reached = 0;
  const srv = http.createServer((req, res) => mw(req, res, () => { reached++; res.end(`app ${req.method} ${req.url}`); }));
  servers.push(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const send = (method, path, headers, body) => new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve({ status: res.statusCode, error: res.headers["ludion-error"], body: s }));
    });
    q.on("error", reject);
    q.end(body);
  });
  return { mw, send, reached: () => reached };
}
const headersOf = (desc) => Object.fromEntries(desc.fields.map((f) => [f.name, f.value]));
const BODY = '{"item":1}';
const post = (authority) => signed({ key: agent, method: "POST", url: `https://${authority}/checkout/1`, body: BODY, headers: { "content-type": "application/json" } });

test("GATE-7: a POST signed for another site, replayed with its Host, is refused before discovery and never reaches the app; the same agent signing for this site passes", async () => {
  const b = await shop({ authorities: ["shop-b.example"] });
  const own = await b.send("POST", "/checkout/1", { ...headersOf(await post("shop-b.example")), host: "shop-b.example" }, BODY);
  assert.equal(own.status, 200, "the agent signing for this site is served (the control)");
  const before = { fetches, reached: b.reached() };
  const replay = await b.send("POST", "/checkout/1", { ...headersOf(await post("shop-a.example")), host: "shop-a.example" }, BODY);
  assert.equal(replay.status, 401);
  assert.equal(replay.error, "invalid_signature");
  assert.equal(b.reached(), before.reached, "the replay never reached the app");
  assert.equal(fetches, before.fetches, "a foreign authority triggers no key discovery");
  const cls = (await b.mw.gate.inspect(await post("shop-a.example"))).cls;
  assert.equal(cls.class, "SPOOFED");
  assert.equal(cls.reason, "foreign_authority");
});

test("GATE-7: behind a trusted proxy, X-Forwarded-Host naming another site is refused; the proxy's own forwarding of this site passes", async () => {
  const b = await shop({ authorities: ["shop-b.example"], trustProxy: true });
  const fwd = (authority) => ({ host: "10.0.0.5:8080", "x-forwarded-host": authority, "x-forwarded-proto": "https" });
  assert.equal((await b.send("POST", "/checkout/1", { ...headersOf(await post("shop-b.example")), ...fwd("shop-b.example") }, BODY)).status, 200);
  const r = await b.send("POST", "/checkout/1", { ...headersOf(await post("shop-a.example")), ...fwd("shop-a.example") }, BODY);
  assert.equal(r.status, 401);
  assert.equal(r.error, "invalid_signature");
});

test("GATE-7: humans are untouched by authority pinning — an unsigned browser with any Host reaches the app as the app answers it", async () => {
  const b = await shop({ authorities: ["shop-b.example"] });
  for (const host of ["shop-b.example", "shop-a.example", "SHOP-B.EXAMPLE", "127.0.0.1"]) {
    const n = b.reached();
    const r = await b.send("GET", "/checkout/1", { host, "user-agent": UA_HUMAN });
    assert.equal(r.status, 200, host);
    assert.equal(r.error, undefined, host);
    assert.equal(b.reached(), n + 1, host);
  }
});

test("GATE-7: the site's own authority in any equivalent spelling verifies (case, trailing dot, default port); another port or a sibling does not", async () => {
  const gate = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, routes: ROUTES, authorities: ["https://shop.example"], resolver: { fetch } });
  const at = async (url) => (await gate.inspect(await signed({ key: agent, url }))).cls;
  for (const url of ["https://shop.example/checkout/1", "https://SHOP.Example/checkout/1", "https://shop.example./checkout/1", "https://shop.example:443/checkout/1"]) {
    const c = await at(url);
    assert.equal(c.class, "VERIFIED", url);
    assert.equal(c.authorityPinned, true, url);
  }
  for (const url of ["https://shop.example:8443/checkout/1", "https://api.shop.example/checkout/1", "https://shop.example.evil/checkout/1", "http://shop.example:443/checkout/1"]) {
    const c = await at(url);
    assert.equal(c.class, "SPOOFED", url);
    assert.equal(c.reason, "foreign_authority", url);
  }
});

test("GATE-7: authorities accept hosts, host:port, origins, *.wildcards (not the apex, not look-alikes), IPv6, or a predicate that must return true", () => {
  const a = createAuthorities(["shop.example", "dev.shop.example:3000", "https://pay.example", "*.cdn.example", "[::1]:8080"]);
  assert.equal(a.pinned, true);
  for (const ok of ["shop.example", "dev.shop.example:3000", "pay.example", "a.cdn.example", "a.b.cdn.example", "[::1]:8080"]) assert.equal(a.allows(ok), true, ok);
  for (const no of ["shop.example:3000", "dev.shop.example", "evilshop.example", "cdn.example", "xcdn.example", "[::1]", "[::1]:8081", "", null]) assert.equal(a.allows(no), false, String(no));
  assert.equal(createAuthorities((x) => x === "shop.example").allows("shop.example"), true);
  assert.equal(createAuthorities(() => 1).allows("shop.example"), false, "only a real true pins an authority in");
  assert.equal(createAuthorities(() => "yes").allows("shop.example"), false);
  assert.equal(requestAuthority("https://SHOP.example.:443/x"), "shop.example");
  assert.equal(requestAuthority("not a url"), null);
});

test("GATE-7: a malformed authorities setting is a TypeError at startup, never a silently open Gate", async () => {
  for (const bad of [[], ["shop.example/checkout"], ["https://shop.example/path"], ["user@shop.example"], ["*"], ["*.*.example"], [""], [42], "shop.example", {}]) {
    await assert.rejects(createGate({ siteId: "s", siteKey, authorities: bad }), TypeError, JSON.stringify(bad));
  }
});

test("GATE-7: unpinned (no authorities), verification still works where nothing is granted, but a Pressure 2 route follows fail_mode: closed by default, open only when the site chose it", async () => {
  const unpinned = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, routes: ROUTES, resolver: { fetch } });
  assert.equal(unpinned.health.authorities, "unpinned");
  const p0 = await unpinned.inspect(await signed({ key: agent, url: "https://anything.example/products" }));
  assert.equal(p0.cls.class, "VERIFIED");
  assert.equal(p0.cls.authorityPinned, false, "the result says it could not be pinned");
  assert.equal(p0.decision.action, "allow");
  const p2 = await unpinned.inspect(await post("shop-a.example"));
  assert.notEqual(p2.cls.class, "VERIFIED");
  assert.equal(p2.decision.action, "deny");
  assert.match(p2.gateError, /authorities not configured/);

  const open = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, routes: ROUTES, resolver: { fetch }, failMode: { pressure_2_3: "open" } });
  assert.equal((await open.inspect(await post("shop-a.example"))).decision.action, "allow", "fail_mode open is the site's explicit choice");

  const pinned = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, routes: ROUTES, resolver: { fetch }, authorities: ["shop-a.example"] });
  assert.equal(pinned.health.authorities, "pinned");
  const ok = await pinned.inspect(await post("shop-a.example"));
  assert.equal(ok.cls.class, "VERIFIED");
  assert.equal(ok.cls.identifier, `${AGENT}/.well-known/http-message-signatures-directory`);
  assert.equal(ok.decision.action, "allow");
});

test("GATE-7: a predicate that throws is the site's fault, not the request's: Pressure 0 stays open, Pressure 2 follows fail_mode", async () => {
  const gate = await createGate({ siteId: "s", siteKey, now: () => NOW_MS, routes: ROUTES, resolver: { fetch }, authorities: () => { throw new Error("boom"); } });
  const p0 = await gate.inspect(await signed({ key: agent, url: "https://shop.example/products" }));
  assert.equal(p0.decision.action, "allow");
  assert.equal(p0.cls.class, "UNKNOWN");
  const p2 = await gate.inspect(await post("shop.example"));
  assert.equal(p2.decision.action, "deny");
  assert.notEqual(p2.cls.class, "VERIFIED");
});
