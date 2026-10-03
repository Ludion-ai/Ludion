// Site configuration (spec §11.4) → GateConfig. The site writes one file in the spec's shape
// (ludion.config.json for Node and Next.js, the `LUDION` var in wrangler.toml for Workers;
// ADR-022); adapters read it and hand it here. Runtime-neutral: no fs, no process, no env.
//
//   { "site_id": "site-7f3a", "pressure": 0,
//     "routes": [{ "match": "/checkout/**", "pressure": 2, "require": { "depth": 2 } }],
//     "report": { "endpoint": "https://…/events", "send_metadata": true },
//     "fail_mode": { "pressure_0_1": "open", "pressure_2_3": "closed" },
//     "authorities": ["shop.example"],
//     "registry": { "keys": [/* the Registry's public JWKs */], "issuer": "https://registry.ludion.ai" } }
//
// Unknown keys are an error: a typo such as "presure": 2 must not silently mean Pressure 0.

import { generateSiteKey } from "./receipt.mjs";
import { SCOPES } from "./mandate.mjs";
import { memoryLedger } from "./ledger.mjs";

const TOP = new Set(["$schema", "site_id", "pressure", "routes", "report", "fail_mode", "timeout_ms", "friction_hook", "trust_proxy", "authorities", "registry", "categories", "mandate_ledger"]);
const REGISTRY = new Set(["keys", "issuer", "revocations"]);
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
 * The sink that POSTs each hourly batch as JSON (ADR-038: counts only, one batch per closed hour,
 * never a visit). Never awaited by the Gate. On Workers each delivery is tracked for ctx.waitUntil.
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
        // A misspelt scope would hold the route to a delegation no Mandate can carry.
        if (scope != null && !SCOPES.includes(scope)) fail(`routes[${i}].require.scope must be one of ${SCOPES.join(", ")} (got ${JSON.stringify(scope)})`);
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
  if (spec.authorities != null) {
    // The site's own hosts (ADR-023). Strings only in a file; createGate validates each entry.
    if (!Array.isArray(spec.authorities) || !spec.authorities.length || !spec.authorities.every((a) => typeof a === "string" && a.length))
      fail('authorities must be a non-empty array of host names, e.g. ["shop.example", "*.shop.example"]');
    out.authorities = [...spec.authorities];
  }
  if (spec.registry != null) {
    // The Registry's public keys, pinned (spec §10.5): without them no Staple or Mandate can be read.
    if (!isObject(spec.registry)) fail("registry must be an object: { keys, issuer?, revocations? }");
    onlyKeys(spec.registry, REGISTRY, "registry");
    const { keys, issuer, revocations } = spec.registry;
    if (Array.isArray(keys) && keys.some((k) => isObject(k) && "d" in k)) fail("registry.keys holds a private key: a site pins the Registry's PUBLIC keys only (served at /.well-known/ludion-keys)");
    if (!Array.isArray(keys) || !keys.length || !keys.every((k) => isObject(k) && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string")) {
      fail("registry.keys must be the Registry's public keys: Ed25519 JWKs, as served at /.well-known/ludion-keys");
    }
    out.registryKeys = { keys: keys.map((k) => ({ ...k })) };
    if (issuer != null) {
      if (typeof issuer !== "string" || !/^https:\/\//.test(issuer)) fail("registry.issuer must be an https URL");
      out.registryIssuer = issuer;
    }
    if (revocations != null) {
      if (typeof revocations !== "string") fail("registry.revocations must be the URL of the Registry's revocation stream");
      try { new URL(revocations); } catch { fail(`registry.revocations is not a URL: ${JSON.stringify(revocations)}`); }
      out.revocations = revocations;
    }
  }
  if (spec.categories != null) {
    // Mandate categories the site belongs to (spec §10.6: a Mandate for "cat:ecommerce").
    if (!Array.isArray(spec.categories) || !spec.categories.every((c) => typeof c === "string" && /^[a-z0-9-]{1,32}$/.test(c))) fail('categories must be lowercase names, e.g. ["ecommerce"]');
    out.categories = [...spec.categories];
  }
  if (spec.trust_proxy != null) {
    if (typeof spec.trust_proxy !== "boolean") fail("trust_proxy must be true or false");
    out.trustProxy = spec.trust_proxy;
  }
  if (spec.mandate_ledger != null) {
    // Where the site counts each Mandate's per_day, once for all of its Gates (PRS-3). "memory":
    // this process is the site's only Gate. { "sqlite": "<file>" }: every Gate process on this
    // machine names the same file (@ludion/gate-node opens it; other runtimes refuse it).
    const l = spec.mandate_ledger;
    if (l === "memory") out.mandateLedger = memoryLedger();
    else if (isObject(l) && Object.keys(l).length === 1 && typeof l.sqlite === "string" && l.sqlite) out.mandateLedgerFile = l.sqlite;
    else fail('mandate_ledger must be "memory" (this process is the site\'s only Gate) or { "sqlite": "<file every Gate process shares>" }');
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
