// The site config (spec §11.4 shape, ADR-022) → GateConfig. Strict: a typo is an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateConfig, httpSink } from "@ludion/gate-core/config";
import { createGate, generateSiteKey } from "@ludion/gate-core";
import { keypair, signed, staple, AGENT, SITE, NOW_MS, REGISTRY_ISS } from "./support.mjs";

test("config: the spec's shape maps onto GateConfig and builds a Gate", async () => {
  const sent = [];
  const cfg = await gateConfig({
    site_id: "site-7f3a", pressure: 1,
    routes: [{ match: "/checkout/**", pressure: 2, require: { depth: 2, scope: "checkout", ballast: "active" } }, { match: "/api/search", pressure: 1 }],
    report: { email: "ops@shop.example", endpoint: "https://collector.example/events", send_metadata: true },
    fail_mode: { pressure_0_1: "open", pressure_2_3: "closed" }, timeout_ms: 1500, trust_proxy: true,
  }, { fetch: async (url, init) => { sent.push([url, init]); return new Response(null, { status: 204 }); } });
  assert.equal(cfg.siteId, "site-7f3a");
  assert.equal(cfg.pressure, 1);
  assert.deepEqual(cfg.routes, [{ match: "/checkout/**", pressure: 2, require: { depth: 2, scope: "checkout", ballast: "active" } }, { match: "/api/search", pressure: 1 }]);
  assert.equal(cfg.sendMetadata, true);
  assert.equal(cfg.timeoutMs, 1500);
  assert.equal(cfg.trustProxy, true);
  assert.equal(cfg.siteKey.kty, "OKP");
  const gate = await createGate(cfg);
  const r = await gate.inspect({ kind: "request", method: "GET", targetUri: "https://shop.example/checkout/1", fields: [{ name: "user-agent", value: "python-requests/2.32.3" }] });
  assert.equal(r.decision.action, "deny");
  assert.equal(r.route.pressure, 2);
  assert.equal(sent.length, 1, "the event went to report.endpoint");
  assert.equal(sent[0][0], "https://collector.example/events");
  assert.equal(JSON.parse(sent[0][1].body).class, "SUSPECTED");
});

test("config: a JSON string works (the Workers --var form); defaults are Pressure 0, nothing sent", async () => {
  const cfg = await gateConfig('{"site_id":"s1"}');
  assert.equal(cfg.pressure, 0);
  assert.equal(cfg.sink, undefined);
  assert.equal(cfg.sendMetadata, undefined);
});

test("config: typos and wrong types are errors, never a silent default", async () => {
  const bad = [
    [{ site_id: "s", presure: 2 }, /unknown key "presure"/],
    [{ pressure: 0 }, /site_id/],
    [{ site_id: "has space" }, /site_id/],
    [{ site_id: "s", pressure: 4 }, /pressure must be an integer 0..3/],
    [{ site_id: "s", pressure: "2" }, /pressure must be an integer/],
    [{ site_id: "s", routes: {} }, /routes must be an array/],
    [{ site_id: "s", routes: [{ match: "checkout" }] }, /must be a path/],
    [{ site_id: "s", routes: [{ match: "/c", presure: 2 }] }, /unknown key "presure" in routes\[0\]/],
    [{ site_id: "s", routes: [{ match: "/c", require: { dept: 1 } }] }, /unknown key "dept"/],
    [{ site_id: "s", routes: [{ match: "/c", require: { depth: -1 } }] }, /depth/],
    [{ site_id: "s", routes: [{ match: "/c", require: { ballast: "yes" } }] }, /ballast/],
    [{ site_id: "s", report: { endpont: "https://x" } }, /unknown key "endpont" in report/],
    [{ site_id: "s", report: { send_metadata: "false" } }, /send_metadata must be true or false/],
    [{ site_id: "s", report: { endpoint: "ftp://x/e" } }, /http\(s\)/],
    [{ site_id: "s", report: { endpoint: "https://user:pw@x/e" } }, /credentials/],
    [{ site_id: "s", timeout_ms: 0 }, /timeout_ms/],
    [{ site_id: "s", trust_proxy: "yes" }, /trust_proxy/],
    ["{not json", /not JSON/],
    [[], /JSON object/],
  ];
  for (const [spec, re] of bad) await assert.rejects(gateConfig(spec), re, JSON.stringify(spec));
});

test("config: the site key comes from a secret; without one an ephemeral key is generated and reported", async () => {
  const { privateJwk } = await generateSiteKey();
  assert.deepEqual((await gateConfig({ site_id: "s" }, { siteKey: JSON.stringify(privateJwk) })).siteKey, privateJwk);
  let told = 0;
  const eph = await gateConfig({ site_id: "s" }, { onEphemeralKey: () => told++ });
  assert.equal(told, 1);
  assert.equal(typeof eph.siteKey.d, "string");
  await assert.rejects(gateConfig({ site_id: "s" }, { siteKey: "{}" }), /private Ed25519 JWK/);
  await assert.rejects(gateConfig({ site_id: "s" }, { siteKey: JSON.stringify({ ...privateJwk, d: undefined }) }), /private Ed25519 JWK/);
});

test("config: httpSink POSTs the event as JSON and nothing else", async () => {
  const calls = [];
  const sink = httpSink("https://collector.example/e", { fetch: async (...a) => { calls.push(a); return new Response(null); } });
  await sink({ v: 0, class: "DECLARED" });
  assert.deepEqual(calls, [["https://collector.example/e", { method: "POST", headers: { "content-type": "application/json" }, body: '{"v":0,"class":"DECLARED"}' }]]);
});

test("config: authorities (ADR-023) map through, and a malformed list is an error", async () => {
  const out = await gateConfig({ site_id: "site-a", authorities: ["shop.example", "*.shop.example"] });
  assert.deepEqual(out.authorities, ["shop.example", "*.shop.example"]);
  for (const bad of ["shop.example", [], [""], [42], {}]) {
    await assert.rejects(gateConfig({ site_id: "site-a", authorities: bad }), TypeError, JSON.stringify(bad));
  }
  const gate = await createGate(out);
  assert.equal(gate.health.authorities, "pinned");
});

test("config: `registry` pins the Registry's public keys, so a file-configured Gate reads Staples and Mandates", async () => {
  const agent = await keypair(), registry = await keypair();
  const cfg = await gateConfig({ site_id: "s", authorities: ["shop.example"], routes: [{ match: "/checkout/**", pressure: 2, require: { depth: 2 } }],
    registry: { keys: [registry.publicJwk], issuer: REGISTRY_ISS, revocations: "https://registry.example/v0/revocations/stream" }, categories: ["ecommerce"] });
  assert.deepEqual(cfg.registryKeys, { keys: [registry.publicJwk] });
  assert.equal(cfg.registryIssuer, REGISTRY_ISS);
  assert.equal(cfg.revocations, "https://registry.example/v0/revocations/stream");
  assert.deepEqual(cfg.categories, ["ecommerce"]);
  const gate = await createGate({ ...cfg, revocations: undefined, now: () => NOW_MS });
  assert.equal(gate.health.registryKeys, "ok");
  await gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  const st = await staple(registry, { jkt: agent.kid, depth: 2 });
  const r = await gate.inspect(await signed({ key: agent, headers: { "ludion-staple": st }, extraComponents: ["ludion-staple"] }));
  assert.equal(r.cls.depth, 2, "the Staple is read");
  assert.equal(r.decision.action, "allow");

  for (const [registry2, re] of [
    [{ keys: [registry.privateJwk] }, /PUBLIC keys only/],
    [{ keys: [] }, /public keys/],
    [{ keys: [{ kty: "RSA", n: "x", e: "AQAB" }] }, /Ed25519/],
    [{ keys: [registry.publicJwk], issuer: "http://registry.example" }, /https URL/],
    [{ keys: [registry.publicJwk], revocations: "not a url" }, /not a URL/],
    [{ keys: [registry.publicJwk], kes: 1 }, /unknown key "kes"/],
    ["keys", /must be an object/],
  ]) await assert.rejects(gateConfig({ site_id: "s", registry: registry2 }), re, JSON.stringify(registry2));
  await assert.rejects(gateConfig({ site_id: "s", categories: ["E-Commerce"] }), /lowercase/);
});

test("config: key discovery uses the fetch in place when it runs, not the one at import", async () => {
  const agent = await keypair();
  const gate = await createGate({ ...(await gateConfig({ site_id: "s", authorities: ["shop.example"] })), now: () => NOW_MS });
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ keys: [{ ...agent.publicJwk, use: "sig" }] }), { status: 200, headers: { "content-type": "application/http-message-signatures-directory+json" } }); };
  try {
    const r = await gate.inspect(await signed({ key: agent, url: `${SITE}/products` }));
    assert.equal(r.cls.class, "VERIFIED");
    assert.deepEqual(asked, [`${AGENT}/.well-known/http-message-signatures-directory`]);
  } finally { globalThis.fetch = real; }
});
