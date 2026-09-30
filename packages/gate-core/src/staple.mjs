// Staple: a short-lived status proof (Depth, Ballast, revocation) signed by the
// Ludion Registry and carried by the agent in the `Ludion-Staple` header.
// The Registry never sits in the request hot path (spec §9.1, invariant 7/8).
//
// Format: compact JWS, alg "EdDSA" (RFC 8037), header {alg, kid, typ:"ludion-staple+jwt"}.
// Binding: payload.cnf.jkt must contain the JWK thumbprint of the key that
// signed the HTTP request (RFC 7800-style confirmation), so a stolen Staple is
// useless with another key (spec §15.2).
//
// Crypto: WebCrypto Ed25519 only. No custom primitives (invariant 11).

import { thumbprint } from "./thumbprint.mjs";

const MAX_STAPLE_BYTES = 4096;
const MAX_LIFETIME_S = 3600; // spec §10.5: at most one hour

export class StapleError extends Error {
  constructor(message, code) { super(message); this.name = "StapleError"; this.code = code; }
}

const b64u = {
  decode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(Buffer.from(s, "base64"));
  },
  encode(bytes) { return Buffer.from(bytes).toString("base64url"); },
};

/**
 * Build a Staple verifier over a pinned Registry JWK Set.
 * @param {{ keys: JsonWebKey[] }} registryJwks  pinned + cached Registry public keys
 * @param {{ issuer?: string, now?: () => number, clockSkewS?: number }} [options]
 */
export async function createStapleVerifier(registryJwks, options = {}) {
  const issuer = options.issuer ?? "https://registry.ludion.ai";
  const now = options.now ?? (() => Date.now());
  const skew = options.clockSkewS ?? 30;
  /** @type {Map<string, CryptoKey>} */
  const keys = new Map();
  // A broken pinned key is skipped, not fatal: a Gate that cannot read one Registry key must still
  // serve the site (GATE-5). Staples under a skipped key then fail as "unknown registry kid".
  let skipped = 0;
  for (const jwk of Array.isArray(registryJwks?.keys) ? registryJwks.keys : []) {
    if (!jwk || typeof jwk !== "object" || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") { skipped++; continue; }
    try {
      const kid = jwk.kid ?? thumbprint({ kty: "OKP", crv: "Ed25519", x: jwk.x });
      const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
      keys.set(kid, key);
    } catch { skipped++; }
  }

  /**
   * @param {string} compact  the Ludion-Staple header value
   * @param {{ requestKeyid: string, diverId?: string }} binding
   * @returns {Promise<object>} the verified payload
   */
  async function verify(compact, binding) {
    if (typeof compact !== "string" || compact.length > MAX_STAPLE_BYTES) throw new StapleError("bad staple size", "format");
    const parts = compact.split(".");
    if (parts.length !== 3) throw new StapleError("not a compact JWS", "format");
    let header, payload;
    try {
      header = JSON.parse(new TextDecoder().decode(b64u.decode(parts[0])));
      payload = JSON.parse(new TextDecoder().decode(b64u.decode(parts[1])));
    } catch { throw new StapleError("staple is not JSON", "format"); }
    if (header.alg !== "EdDSA") throw new StapleError("staple alg must be EdDSA", "alg");
    const key = keys.get(header.kid);
    if (!key) throw new StapleError("unknown registry kid", "kid");
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64u.decode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new StapleError("staple signature invalid", "sig");

    const t = Math.floor(now() / 1000);
    if (payload.iss !== issuer) throw new StapleError("staple issuer mismatch", "iss");
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) throw new StapleError("staple missing iat/exp", "time");
    if (payload.exp - payload.iat > MAX_LIFETIME_S) throw new StapleError("staple lifetime too long", "time");
    if (payload.iat > t + skew) throw new StapleError("staple from the future", "time");
    if (payload.exp < t - skew) throw new StapleError("staple expired", "expired");
    if (typeof payload.sub !== "string" || !/^dvr-[a-z2-7]{16}$/.test(payload.sub)) throw new StapleError("bad staple subject", "sub");
    const jkts = payload?.cnf?.jkt;
    const jktList = Array.isArray(jkts) ? jkts : typeof jkts === "string" ? [jkts] : [];
    if (!jktList.includes(binding.requestKeyid)) throw new StapleError("staple not bound to request key", "cnf");
    if (binding.diverId && payload.sub !== binding.diverId) throw new StapleError("staple subject mismatch", "sub");
    if (!Number.isInteger(payload.depth) || payload.depth < 0 || payload.depth > 4) throw new StapleError("bad depth", "depth");
    return payload;
  }

  return { verify, kids: [...keys.keys()], skipped };
}

/**
 * Issue a Staple. Used by the Registry (services/registry) and by tests.
 * @param {CryptoKey} privateKey Ed25519 private key
 * @param {string} kid
 * @param {object} payload
 */
export async function issueStaple(privateKey, kid, payload) {
  const header = { alg: "EdDSA", kid, typ: "ludion-staple+jwt" };
  const h = b64u.encode(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64u.encode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u.encode(sig)}`;
}
