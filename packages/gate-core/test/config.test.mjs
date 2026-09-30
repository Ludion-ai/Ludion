// The site config (spec §11.4 shape, ADR-022) → GateConfig. Strict: a typo is an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateConfig, httpSink } from "@ludion/gate-core/config";
import { createGate, generateSiteKey } from "@ludion/gate-core";

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
