// @ludion/gate-core — the Gate (spec §11).
//
//   60 seconds to install, breaks nothing, and tomorrow morning fear is a number.
//
// One call: gate.inspect(requestDescriptor) → { cls, decision, receipt, headers }.
// Adapters (Node, Next.js, Workers, …) only translate their request shape into an
// RFC 9421 RequestDescriptor and apply the returned decision.

import { createResolver } from "./resolver.mjs";
import { createStapleVerifier, issueStaple } from "./staple.mjs";
import { classify, createPolicy, createNonceCache, decide, ERROR_HELP, AUTOMATION, compileRoute, CLASSES } from "./classify.mjs";
import { createReceipts, importSiteKey, generateSiteKey, metadataEvent, templatePath, hashIp } from "./receipt.mjs";
import { KNOWN_AGENT_TOKENS, AUTOMATION_SIGNALS, matchKnownAgent, matchAutomationSignal } from "./agents.mjs";
import { GateFault, within, clock } from "./budget.mjs";
import { routeKind, isCritical, pathOf, queryKeys, templateSegment, publicTemplateSegment, isRouteWord, ROUTE_KINDS, CRITICAL_KINDS, WRITE_METHODS } from "./route.mjs";

export {
  createResolver, createStapleVerifier, issueStaple, classify, createPolicy, createNonceCache, decide, compileRoute, CLASSES,
  ERROR_HELP, AUTOMATION, createReceipts, importSiteKey, generateSiteKey, metadataEvent, templatePath, hashIp,
  KNOWN_AGENT_TOKENS, AUTOMATION_SIGNALS, matchKnownAgent, matchAutomationSignal, GateFault,
  routeKind, isCritical, pathOf, queryKeys, templateSegment, publicTemplateSegment, isRouteWord, ROUTE_KINDS, CRITICAL_KINDS, WRITE_METHODS,
};

export const LUDION_VERSION = "0";

/** RFC 9421 §5.1 Accept-Signature sent with signature_required (draft §5.3). */
export const ACCEPT_SIGNATURE = 'sig1=("@authority" "signature-agent";key="sig1" "@method" "@path");tag="web-bot-auth"';

/** Headers every rejection carries (spec §10.11): the error, a help link, and how to sign. */
export function denialHeaders(decision) {
  if (decision.action !== "deny") return {};
  return {
    "Ludion-Error": decision.error,
    "Link": ERROR_HELP(decision.error),
    ...(decision.error === "signature_required" ? { "Accept-Signature": ACCEPT_SIGNATURE } : {}),
  };
}

/**
 * @typedef {object} GateConfig
 * @property {string} siteId
 * @property {JsonWebKey} siteKey                 private Ed25519 JWK (Glass receipts)
 * @property {number} [pressure]                  0..3, default 0
 * @property {Array<{match:string,pressure?:number,require?:object}>} [routes]
 * @property {{ keys: JsonWebKey[] }} [registryKeys]  pinned Ludion Registry JWKS (Staple verification)
 * @property {string} [registryIssuer]
 * @property {"open"|"closed"|{pressure_0_1?:"open", pressure_2_3?:"open"|"closed"}} [failMode]
 *           what a fault inside the Gate does on Pressure 2–3 routes (spec §11.4); default closed.
 *           Pressure 0–1 always fails open: a broken Gate never touches those routes (ADR-020).
 * @property {number} [timeoutMs]                 the most the Gate may add to one request; default 3000
 * @property {object} [resolver]                  options for createResolver
 * @property {(event: object) => void|Promise<void>} [sink]  metadata sink; never awaited, never blocks
 * @property {boolean} [sendMetadata]             spec report.send_metadata; default: true iff a sink is set
 * @property {string} [ipSalt]                    per-site salt for IP hashing
 * @property {boolean} [requireNonce]
 * @property {() => number} [now]
 */

export const DEFAULT_TIMEOUT_MS = 3000;

/** Standing a Staple would prove. Unprovable for lack of Registry keys is the Gate's fault. */
const STANDING_ERRORS = new Set(["depth_insufficient", "ballast_required"]);

/** spec §11.4 fail_mode → the mode for Pressure 2–3 routes. Pressure 0–1 is always open. */
export function parseFailMode(fm) {
  if (fm == null) return "closed";
  if (fm === "open" || fm === "closed") return fm;
  if (typeof fm === "object" && !Array.isArray(fm)) {
    const low = fm.pressure_0_1 ?? "open", high = fm.pressure_2_3 ?? "closed";
    if (low !== "open") throw new TypeError(`failMode.pressure_0_1 must be "open" (got ${JSON.stringify(low)}): Pressure 0–1 never blocks on a Gate fault`);
    if (high !== "open" && high !== "closed") throw new TypeError(`failMode.pressure_2_3 must be "open" or "closed" (got ${JSON.stringify(high)})`);
    return high;
  }
  throw new TypeError(`failMode must be "open", "closed" or { pressure_0_1, pressure_2_3 } (got ${JSON.stringify(fm)})`);
}

/** The path a target routes on, whatever the target looks like (a broken Host must not reroute). */
export function routePath(target) {
  if (typeof target === "string") {
    try { return new URL(target).pathname; } catch { /* fall through */ }
    const p = pathOf(target);
    if (p != null) {
      try { return new URL(p.replace(/^\/+/, "/") || "/", "http://gate.invalid").pathname; } catch { /* fall through */ }
    }
  }
  return "/";
}

/** @param {GateConfig} config */
export async function createGate(config) {
  if (!config?.siteId) throw new Error("siteId required");
  if (!config?.siteKey) throw new Error("siteKey required (use generateSiteKey())");
  const now = config.now ?? (() => Date.now());
  const failClosed = parseFailMode(config.failMode) === "closed";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive number");
  // Discovery ends a little before the hard deadline, so a slow directory is UNVERIFIED rather
  // than a Gate fault (ADR-020); the rest of the budget covers verification.
  const discoveryMs = timeoutMs - Math.min(250, timeoutMs / 5);
  const resolver = createResolver({ now, ...(config.resolver ?? {}) });

  // Registry keys that cannot be read degrade to "no Registry keys"; they never stop the site.
  const health = { registryKeys: config.registryKeys == null ? "none" : "ok", registryKeyCount: 0, registryKeysSkipped: 0 };
  let stapleVerifier;
  if (config.registryKeys != null) {
    try {
      const v = await createStapleVerifier(config.registryKeys, { issuer: config.registryIssuer, now });
      health.registryKeyCount = v.kids.length; health.registryKeysSkipped = v.skipped;
      if (v.kids.length) stapleVerifier = v;
      health.registryKeys = !v.kids.length ? "unusable" : v.skipped ? "partial" : "ok";
    } catch (e) { health.registryKeys = "unusable"; health.registryKeysError = String(e?.message ?? e); }
  }

  const policy = createPolicy({ pressure: config.pressure, routes: config.routes });
  const nonceCache = createNonceCache({ now });
  const siteKey = await importSiteKey(config.siteKey);
  const receipts = createReceipts({ siteId: config.siteId, siteKey, now });
  const ipSalt = config.ipSalt ?? config.siteId;
  const sendMetadata = config.sendMetadata ?? (config.sink != null);

  /** Hand an event to the sink without waiting: a slow or broken sink costs the request nothing. */
  function emit(event) {
    try {
      const r = config.sink(event);
      if (r && typeof r.then === "function") r.then(undefined, () => {});
    } catch { /* never block the request */ }
  }

  /** A fault inside the Gate: open on Pressure 0–1, fail_mode on 2–3 (spec §11.4). */
  function faultClass(route, e) {
    const gateError = String(e?.message ?? e).slice(0, 200);
    return route.pressure >= 2 && failClosed ? { class: "SUSPECTED", signal: "gate_error", gateError } : { class: "UNKNOWN", gateError };
  }

  /** The result for a request the Gate could not inspect at all. Never throws. */
  function failSafe(target, e) {
    let route;
    try { route = policy.forPath(routePath(target)); } catch { route = { pressure: 3, require: null, template: null }; }
    const cls = faultClass(route, e);
    const decision = decide(cls, route);
    return { cls, decision, receipt: null, headers: { "Ludion-Version": LUDION_VERSION, ...denialHeaders(decision) }, route, gateError: cls.gateError };
  }

  /**
   * @param {import("http-message-sig").RequestDescriptor} req
   * @param {{ ip?: string, country?: string }} meta
   */
  async function inspectOnce(req, meta) {
    const started = clock();
    const path = routePath(req.targetUri);
    const route = policy.forPath(path);
    let cls, gateError;
    try {
      cls = await within(
        classify(req, { resolver, stapleVerifier, nonceCache, now, requireNonce: config.requireNonce, discoveryDeadline: started + discoveryMs }),
        timeoutMs - (clock() - started),
        () => new GateFault(`classification exceeded timeoutMs (${timeoutMs}ms)`, "timeout"));
    } catch (e) {
      gateError = e;
      cls = faultClass(route, e);
    }
    let decision = decide(cls, route);
    if (decision.action === "deny" && cls.stapleError === "no_registry_keys" && STANDING_ERRORS.has(decision.error) && !failClosed) {
      decision = { action: "allow", failOpen: "no_registry_keys" };
    }
    const headers = { "Ludion-Version": LUDION_VERSION, ...denialHeaders(decision) };
    let receipt = null;
    try {
      const sigField = req.fields.find((f) => f.name.toLowerCase() === "signature")?.value;
      receipt = await receipts.issue({ method: req.method, path, cls, decision, pressure: route.pressure, signature: sigField });
      headers["Ludion-Receipt"] = receipts.toHeader(receipt);
    } catch (e) { gateError ??= e; } // a receipt is evidence, not the decision: losing it never changes the response
    if (receipt && sendMetadata && config.sink && AUTOMATION.has(cls.class)) {
      emit(metadataEvent({ receipt, ip: meta.ip, ipSalt, country: meta.country }));
    }
    return { cls, decision, receipt, headers, route, ...(gateError ? { gateError: String(gateError?.message ?? gateError).slice(0, 200) } : {}) };
  }

  /** Never throws; adds at most timeoutMs plus the receipt signature. */
  async function inspect(req, meta = {}) {
    try { return await inspectOnce(req, meta ?? {}); }
    catch (e) { return failSafe(req?.targetUri, e); }
  }

  return { inspect, failSafe, resolver, receipts, policy, health, timeoutMs, siteKey: { kid: siteKey.kid, publicKey: siteKey.publicKey } };
}
