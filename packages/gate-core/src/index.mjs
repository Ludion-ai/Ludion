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

export {
  createResolver, createStapleVerifier, issueStaple, classify, createPolicy, createNonceCache, decide, compileRoute, CLASSES,
  ERROR_HELP, AUTOMATION, createReceipts, importSiteKey, generateSiteKey, metadataEvent, templatePath, hashIp,
  KNOWN_AGENT_TOKENS, AUTOMATION_SIGNALS, matchKnownAgent, matchAutomationSignal,
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
 * @property {"open"|"closed"} [failMode]         default: open for P0/1, closed for P2/3
 * @property {object} [resolver]                  options for createResolver
 * @property {(event: object) => void|Promise<void>} [sink]  metadata sink; undefined = nothing leaves the site
 * @property {string} [ipSalt]                    per-site salt for IP hashing
 * @property {boolean} [requireNonce]
 * @property {() => number} [now]
 */

/** @param {GateConfig} config */
export async function createGate(config) {
  if (!config?.siteId) throw new Error("siteId required");
  if (!config?.siteKey) throw new Error("siteKey required (use generateSiteKey())");
  const now = config.now ?? (() => Date.now());
  const resolver = createResolver({ now, ...(config.resolver ?? {}) });
  const stapleVerifier = config.registryKeys
    ? await createStapleVerifier(config.registryKeys, { issuer: config.registryIssuer, now })
    : undefined;
  const policy = createPolicy({ pressure: config.pressure, routes: config.routes });
  const nonceCache = createNonceCache({ now });
  const siteKey = await importSiteKey(config.siteKey);
  const receipts = createReceipts({ siteId: config.siteId, siteKey, now });
  const ipSalt = config.ipSalt ?? config.siteId;

  /**
   * @param {import("http-message-sig").RequestDescriptor} req
   * @param {{ ip?: string, country?: string }} [meta]
   */
  async function inspect(req, meta = {}) {
    const url = new URL(req.targetUri);
    const route = policy.forPath(url.pathname);
    let cls;
    try {
      cls = await classify(req, { resolver, stapleVerifier, nonceCache, now, requireNonce: config.requireNonce });
    } catch (e) {
      // Gate failure must not take the site down (spec §11.4 fail_mode).
      const failClosed = config.failMode === "closed" || (config.failMode == null && route.pressure >= 2);
      cls = { class: "UNKNOWN", gateError: String(e?.message ?? e) };
      if (failClosed) cls = { class: "SUSPECTED", signal: "gate_error", gateError: cls.gateError };
    }
    const decision = decide(cls, route);
    const sigField = req.fields.find((f) => f.name.toLowerCase() === "signature")?.value;
    const receipt = await receipts.issue({ method: req.method, path: url.pathname, cls, decision, pressure: route.pressure, signature: sigField });

    const headers = { "Ludion-Version": LUDION_VERSION, "Ludion-Receipt": receipts.toHeader(receipt), ...denialHeaders(decision) };
    if (config.sink && AUTOMATION.has(cls.class)) {
      try { await config.sink(metadataEvent({ receipt, ip: meta.ip, ipSalt, country: meta.country })); } catch { /* never block the request */ }
    }
    return { cls, decision, receipt, headers, route };
  }

  return { inspect, resolver, receipts, policy, siteKey: { kid: siteKey.kid, publicKey: siteKey.publicKey } };
}
