// Test harness shared by the oracle suites: keys, arbitrary (also malformed) RFC 9421
// signatures built with the audited libraries, and a Gate with a primed resolver.
// No network: directories are pinned with resolver.prime().
import { createSignature, component } from "http-message-sig";
import { signerFromJWK } from "web-bot-auth/crypto";
import { generateNonce } from "web-bot-auth";
import { createHash } from "node:crypto";
import { createGate, generateSiteKey, issueStaple } from "../src/index.mjs";
import { thumbprint } from "../src/thumbprint.mjs";

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;
export const AGENT = "https://agent.example";
export const ATTACKER = "https://attacker.example";
export const SITE = "https://shop.example";
export const REGISTRY_ISS = "https://registry.ludion.ai";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x };
  const kid = thumbprint(publicJwk);
  return { kid, publicJwk: { ...publicJwk, kid }, privateJwk: { ...publicJwk, d: priv.d, kid }, privateKey: kp.privateKey };
}

/** A signer that signs with `key` but may claim another keyid in the signature parameters. */
async function signerFor(key) { return signerFromJWK({ kty: "OKP", crv: "Ed25519", x: key.publicJwk.x, d: key.privateJwk.d }); }

export const digestOf = (body) => `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

/**
 * Build a signed RequestDescriptor. Every knob can be bent so negative tests start from a
 * request that differs from a VERIFIED one in exactly one way. Pass `null` to omit a parameter
 * (`undefined` falls back to the default).
 */
export async function signed({
  key, method = "GET", url = `${SITE}/checkout/1`, headers = {}, body,
  agent = AGENT, agentHeader, label = "sig1", agentKey = label,
  components, extraComponents = [], created = NOW_S, expires, lifetime = 60,
  keyid, alg = "ed25519", tag = "web-bot-auth", nonce = generateNonce(),
}) {
  const h = { "user-agent": "ExampleAgent/1.0", ...headers };
  h["signature-agent"] = agentHeader ?? `${agentKey}="${agent}"`;
  if (body != null && STATE_CHANGING.has(method)) h["content-digest"] = digestOf(body);
  const comps = components ?? [
    "@authority", component("signature-agent", { key: agentKey }),
    ...(STATE_CHANGING.has(method) ? ["@method", "@path", ...(body != null ? ["content-digest"] : [])] : []),
    ...extraComponents,
  ];
  const req = { kind: "request", method, targetUri: url, fields: Object.entries(h).map(([name, value]) => ({ name, value })) };
  const out = await createSignature(req, {
    label, components: comps, signer: await signerFor(key),
    parameters: { created: created ?? undefined, keyid: keyid ?? key.kid, alg: alg ?? undefined,
      expires: expires === null ? undefined : expires ?? created + lifetime, nonce: nonce ?? undefined, tag: tag ?? undefined },
  });
  req.fields.push({ name: "signature-input", value: out.signatureInput }, { name: "signature", value: out.signature });
  return req;
}

/** Replace (or with value === undefined, remove) header fields on a descriptor copy. */
export function withFields(req, patch) {
  const lower = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k.toLowerCase(), v]));
  const fields = req.fields.filter((f) => !(f.name.toLowerCase() in lower));
  for (const [name, value] of Object.entries(lower)) if (value !== undefined) fields.push({ name, value });
  return { ...req, fields };
}
export const fieldOf = (req, name) => req.fields.find((f) => f.name.toLowerCase() === name)?.value;
export const retarget = (req, targetUri) => ({ ...req, targetUri });

/**
 * A Gate at Pressure 0 with critical routes at Pressure 2, directories pinned for the
 * honest agent (and optionally an attacker), and a pinned Registry for Staples.
 */
export async function harness({ agentKeys, attackerKeys = [], registry, routes, now = () => NOW_MS, ...rest } = {}) {
  const siteKey = await generateSiteKey();
  const gate = await createGate({
    siteId: "site-test", siteKey: siteKey.privateJwk, pressure: 0, now,
    routes: routes ?? [{ match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2, require: { depth: 1 } }],
    ...(registry ? { registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS } : {}),
    ...rest,
  });
  await gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: agentKeys.map((k) => ({ ...k.publicJwk, use: "sig" })) });
  if (attackerKeys.length) await gate.resolver.prime({ type: "directory", uri: ATTACKER }, { keys: attackerKeys.map((k) => ({ ...k.publicJwk, use: "sig" })) });
  return gate;
}

export async function staple(registry, { sub = "dvr-aaaaaaaaaaaaaaaa", jkt, depth = 2, iat = NOW_S, exp = NOW_S + 3600, ...rest }) {
  return issueStaple(registry.privateKey, registry.kid, { iss: REGISTRY_ISS, sub, iat, exp, depth, ballast: { status: "active" }, cnf: { jkt: [jkt] }, ...rest });
}

/**
 * The shape every rejection must have: not VERIFIED, no Staple-derived standing (depth, diver),
 * and denied on a Pressure-2 route. Returns the list of violations (empty = rejected).
 * `victim`: the identifier the attacker must never be attributed to.
 */
export function rejected(result, { victim } = {}) {
  const problems = [];
  const c = result.cls;
  if (c.class === "VERIFIED") problems.push(`class VERIFIED (identifier ${c.identifier}, depth ${c.depth})`);
  if (c.class !== "REVOKED" && (c.diverId || c.staple || (c.depth ?? 0) > 0)) problems.push(`non-VERIFIED result carries Staple standing (diver ${c.diverId}, depth ${c.depth})`);
  if (victim && c.class === "VERIFIED" && c.identifier === victim) problems.push(`attributed to ${victim}`);
  if (result.route.pressure >= 2 && result.decision.action !== "deny") problems.push(`decision ${result.decision.action} on a Pressure ${result.route.pressure} route`);
  return problems;
}
