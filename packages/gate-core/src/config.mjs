// Site configuration (spec §11.4) → GateConfig. The site writes one file in the spec's shape
// (ludion.config.json for Node and Next.js, the `LUDION` var in wrangler.toml for Workers;
// ADR-022); adapters read it and hand it here. Runtime-neutral: no fs, no process, no env.
//
//   { "site_id": "site-7f3a", "pressure": 0,
//     "routes": [{ "match": "/checkout/**", "pressure": 2, "require": { "depth": 2 } }],
//     "report": { "endpoint": "https://…/events", "send_metadata": true },
//     "fail_mode": { "pressure_0_1": "open", "pressure_2_3": "closed" } }
//
// Unknown keys are an error: a typo such as "presure": 2 must not silently mean Pressure 0.

import { generateSiteKey } from "./receipt.mjs";

const TOP = new Set(["$schema", "site_id", "pressure", "routes", "report", "fail_mode", "timeout_ms", "friction_hook", "trust_proxy"]);
const REPORT = new Set(["email", "endpoint", "send_metadata"]);
const ROUTE = new Set(["match", "pressure", "require"]);
const REQUIRE = new Set(["depth", "scope", "ballast"]);

const fail = (msg) => { throw new TypeError(`ludion config: ${msg}`); };
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(`unknown key ${JSON.stringify(k)} in ${where} (known: ${[...allowed].join(", ")})`);
}
function pressureOf(v, where) {
  if (!Number.isInteger(v) || v < 0 || v > 3) fail(`${where} must be an integer 0..3 (got ${JSON.stringify(v)})`);
  return v;
}

/**
 * A metadata sink that POSTs each event as JSON. Never awaited by the Gate (spec §11.7: the event
 * already carries metadata only). `track` receives each pending delivery (Workers: ctx.waitUntil).
 * @param {string} endpoint
 * @param {{ fetch?: typeof fetch }} [opts]
 */
export function httpSink(endpoint, { fetch = globalThis.fetch } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`report.endpoint must be http(s) (got ${url.protocol})`);
  if (url.username || url.password) fail("report.endpoint must not carry credentials");
  return (event) => fetch(url.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
}

/**
 * Validate the site's config and turn it into a GateConfig.
 * @param {unknown} spec              parsed ludion.config.json (or the Workers `LUDION` var)
 * @param {{ siteKey?: string | JsonWebKey, fetch?: typeof fetch, onEphemeralKey?: () => void }} [opts]
 *        siteKey: the Glass receipt key (JWK or its JSON), from a secret — never from the config
 *        file. Without one, an ephemeral key is generated: receipts then verify only for the life
 *        of the process.
 */
export async function gateConfig(spec, { siteKey, fetch, onEphemeralKey } = {}) {
  if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch (e) { fail(`not JSON: ${e.message}`); } }
  if (!isObject(spec)) fail("must be a JSON object");
  onlyKeys(spec, TOP, "the config");
  if (typeof spec.site_id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(spec.site_id)) fail("site_id must be a string of letters, digits, '.', '_' or '-'");

  const out = { siteId: spec.site_id, pressure: spec.pressure == null ? 0 : pressureOf(spec.pressure, "pressure") };

  if (spec.routes != null) {
    if (!Array.isArray(spec.routes)) fail("routes must be an array");
    out.routes = spec.routes.map((r, i) => {
      if (!isObject(r)) fail(`routes[${i}] must be an object`);
      onlyKeys(r, ROUTE, `routes[${i}]`);
      if (typeof r.match !== "string" || !r.match.startsWith("/")) fail(`routes[${i}].match must be a path starting with "/"`);
      const route = { match: r.match };
      if (r.pressure != null) route.pressure = pressureOf(r.pressure, `routes[${i}].pressure`);
      if (r.require != null) {
        if (!isObject(r.require)) fail(`routes[${i}].require must be an object`);
        onlyKeys(r.require, REQUIRE, `routes[${i}].require`);
        const { depth, scope, ballast } = r.require;
        if (depth != null && (!Number.isInteger(depth) || depth < 0)) fail(`routes[${i}].require.depth must be a non-negative integer`);
        if (scope != null && typeof scope !== "string") fail(`routes[${i}].require.scope must be a string`);
        if (ballast != null && ballast !== "active") fail(`routes[${i}].require.ballast must be "active"`);
        route.require = { ...r.require };
      }
      return route;
    });
  }

  if (spec.report != null) {
    if (!isObject(spec.report)) fail("report must be an object");
    onlyKeys(spec.report, REPORT, "report");
    const { endpoint, send_metadata: send } = spec.report;
    if (send != null && typeof send !== "boolean") fail("report.send_metadata must be true or false");
    if (endpoint != null) {
      if (typeof endpoint !== "string") fail("report.endpoint must be a URL string");
      out.sink = httpSink(endpoint, { fetch });
    }
    out.sendMetadata = send ?? out.sink != null;
  }

  if (spec.fail_mode != null) out.failMode = spec.fail_mode; // createGate validates the spec shape
  if (spec.timeout_ms != null) {
    if (!Number.isFinite(spec.timeout_ms) || spec.timeout_ms <= 0) fail("timeout_ms must be a positive number");
    out.timeoutMs = spec.timeout_ms;
  }
  if (spec.trust_proxy != null) {
    if (typeof spec.trust_proxy !== "boolean") fail("trust_proxy must be true or false");
    out.trustProxy = spec.trust_proxy;
  }

  if (siteKey != null && siteKey !== "") {
    let jwk = siteKey;
    if (typeof jwk === "string") { try { jwk = JSON.parse(jwk); } catch { fail("the site key must be a JWK (JSON)"); } }
    if (!isObject(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") fail("the site key must be a private Ed25519 JWK");
    out.siteKey = jwk;
  } else {
    out.siteKey = (await generateSiteKey()).privateJwk;
    onEphemeralKey?.();
  }
  return out;
}
