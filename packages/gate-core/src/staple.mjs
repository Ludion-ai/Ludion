// Staple: a short-lived status proof (Depth, Ballast, revocation) signed by the
// Ludion Registry and carried by the agent in the `Ludion-Staple` header.
// The Registry never sits in the request hot path (spec §9.1, invariant 7/8).
//
// Format: compact JWS, alg "EdDSA" (RFC 8037), header {alg, kid, typ:"ludion-staple+jwt"}.
// Binding: payload.cnf.jkt must contain the JWK thumbprint of the key that
// signed the HTTP request (RFC 7800-style confirmation), so a stolen Staple is
// useless with another key (spec §15.2).
//
// Crypto: WebCrypto only. No custom primitives (invariant 11). This is one of the modules CRY-1
// allows to hold primitives: Staples, the Registry's other statements (revocations, Mandates), and
// the passkey checks and pseudonyms behind Mandate v0 (below).

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
    const { header, payload } = await checkRegistrySignature(compact, MAX_STAPLE_BYTES);
    // Other statements the Registry signs (revocation entries) must never pass as a Staple.
    if (header.typ !== undefined && header.typ !== STAPLE_TYP) throw new StapleError("not a staple", "typ");

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

  /** Parse a compact JWS and check its EdDSA signature under a pinned Registry key. */
  async function checkRegistrySignature(compact, maxBytes) {
    const { header, payload, signingInput, signature } = parseJws(compact, maxBytes);
    const key = keys.get(header.kid);
    if (!key) throw new StapleError("unknown registry kid", "kid");
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signingInput);
    if (!ok) throw new StapleError("staple signature invalid", "sig");
    return { header, payload };
  }

  /**
   * Verify another statement the Registry signs with its pinned keys (revocation entries:
   * typ "ludion-revocation+jwt"): signature, typ and issuer. Returns the payload.
   * @param {string} compact @param {{ typ: string }} expect
   */
  async function verifyStatement(compact, { typ }) {
    const { header, payload } = await checkRegistrySignature(compact, MAX_STATEMENT_BYTES);
    if (header.typ !== typ) throw new StapleError(`expected ${typ}`, "typ");
    if (payload.iss !== issuer) throw new StapleError("statement issuer mismatch", "iss");
    return payload;
  }

  return { verify, verifyStatement, kids: [...keys.keys()], skipped };
}

const STAPLE_TYP = "ludion-staple+jwt";
const MAX_STATEMENT_BYTES = 8192;

/** Split and decode a compact JWS (alg EdDSA only). Throws StapleError on any malformation. */
function parseJws(compact, maxBytes) {
  if (typeof compact !== "string" || compact.length > maxBytes) throw new StapleError("bad staple size", "format");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new StapleError("not a compact JWS", "format");
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64u.decode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64u.decode(parts[1])));
  } catch { throw new StapleError("staple is not JSON", "format"); }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") throw new StapleError("staple is not JSON", "format");
  if (header.alg !== "EdDSA") throw new StapleError("staple alg must be EdDSA", "alg");
  return { header, payload, signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`), signature: b64u.decode(parts[2]) };
}

/**
 * Verify a compact EdDSA JWS under one given public key (no kid lookup): the statements a Diver's
 * Root signs for the Registry (registration, key approval, revocation). Returns { header, payload }.
 * @param {string} compact
 * @param {JsonWebKey} publicJwk  Ed25519 public JWK
 * @param {{ typ: string, maxBytes?: number }} expect
 */
export async function verifyJws(compact, publicJwk, { typ, maxBytes = MAX_STATEMENT_BYTES }) {
  const { header, payload, signingInput, signature } = parseJws(compact, maxBytes);
  if (header.typ !== typ) throw new StapleError(`expected ${typ}`, "typ");
  if (publicJwk?.kty !== "OKP" || publicJwk.crv !== "Ed25519" || typeof publicJwk.x !== "string") throw new StapleError("not an Ed25519 public key", "kid");
  let key;
  try { key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicJwk.x }, { name: "Ed25519" }, false, ["verify"]); }
  catch { throw new StapleError("not an Ed25519 public key", "kid"); }
  if (!await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signingInput)) throw new StapleError("signature invalid", "sig");
  return { header, payload };
}

/**
 * A Registry signing key (spec §10.3 "Registry Intermediate"), for the Registry and tests.
 * Production keys are made and held by a human (HSM); this code never generates them.
 * @param {JsonWebKey} privateJwk  Ed25519 private JWK
 * @returns {Promise<{ privateKey: CryptoKey, kid: string, publicJwk: JsonWebKey }>}
 */
export async function importRegistryKey(privateJwk) {
  if (privateJwk?.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string" || typeof privateJwk.x !== "string") {
    throw new Error("the Registry key must be a private Ed25519 JWK");
  }
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d }, { name: "Ed25519" }, false, ["sign"]);
  const pub = { kty: "OKP", crv: "Ed25519", x: privateJwk.x };
  const kid = privateJwk.kid ?? thumbprint(pub);
  return { privateKey, kid, publicJwk: { ...pub, kid, use: "sig", alg: "EdDSA" } };
}

/** A fresh Registry key: development and tests only. */
export async function generateRegistryKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const kid = thumbprint({ kty: "OKP", crv: "Ed25519", x: priv.x });
  return {
    privateJwk: { kty: "OKP", crv: "Ed25519", x: priv.x, d: priv.d, kid },
    publicJwk: { kty: "OKP", crv: "Ed25519", x: priv.x, kid, use: "sig", alg: "EdDSA" },
    kid,
  };
}

/**
 * Sign a compact JWS (EdDSA, RFC 8037) with a Registry key.
 * @param {CryptoKey} privateKey @param {string} kid @param {string} typ @param {object} payload
 */
export async function signJws(privateKey, kid, typ, payload) {
  const h = b64u.encode(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", kid, typ })));
  const p = b64u.encode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u.encode(sig)}`;
}

/**
 * Issue a Staple. Used by the Registry (services/registry) and by tests.
 * @param {CryptoKey} privateKey Ed25519 private key
 * @param {string} kid
 * @param {object} payload
 */
export async function issueStaple(privateKey, kid, payload) {
  return signJws(privateKey, kid, STAPLE_TYP, payload);
}

// ── Passkeys and pseudonyms (Mandate v0, spec §10.6, §10.2) ─────────────────────────────────
// The Registry issues a Mandate only on a Principal's passkey consent, and names the Principal to
// each site by a pairwise pseudonym. Both need primitives, and primitives live in this module
// (CRY-1): WebCrypto ECDSA P-256 (COSE -7) and Ed25519 (COSE -8), and HMAC-SHA-256.

const PASSKEY_ALGS = { [-7]: { name: "ECDSA", namedCurve: "P-256" }, [-8]: { name: "Ed25519" } };

/**
 * A passkey's public key as the browser hands it over at registration
 * (AuthenticatorAttestationResponse.getPublicKey(): SubjectPublicKeyInfo DER) → a public JWK.
 * @param {Uint8Array} spki @param {number} coseAlg  -7 (ES256) or -8 (EdDSA)
 */
export async function passkeyPublicJwk(spki, coseAlg) {
  const algorithm = PASSKEY_ALGS[coseAlg];
  if (!algorithm) throw new StapleError(`unsupported passkey algorithm ${coseAlg}`, "alg");
  let key;
  try { key = await crypto.subtle.importKey("spki", spki, algorithm, true, ["verify"]); }
  catch { throw new StapleError("not a public key for that algorithm", "kid"); }
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return coseAlg === -7 ? { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } : { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

/**
 * ASN.1 DER ECDSA-Sig-Value (SEQUENCE { INTEGER r, INTEGER s }), as WebAuthn carries ES256
 * signatures (WebAuthn §6.5.6), → the fixed-width r‖s WebCrypto verifies. Strict DER only.
 * @param {Uint8Array} der @param {number} size  bytes per integer (32 for P-256)
 */
export function derToRawEcdsa(der, size) {
  const bad = () => { throw new StapleError("not a DER ECDSA signature", "sig"); };
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[1] > 0x7f) bad();
  let i = 2;
  const out = new Uint8Array(size * 2);
  for (const at of [0, size]) {
    if (der[i] !== 0x02) bad();
    const len = der[i + 1];
    if (len < 1 || len > size + 1 || i + 2 + len > der.length) bad();
    let v = der.subarray(i + 2, i + 2 + len);
    if (v[0] & 0x80) bad(); // negative
    if (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) bad(); // non-minimal
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > size) bad();
    out.set(v, at + size - v.length);
    i += 2 + len;
  }
  if (i !== der.length) bad();
  return out;
}

/**
 * Verify a WebAuthn assertion signature (over authenticatorData ‖ SHA-256(clientDataJSON))
 * under a passkey's public JWK (from passkeyPublicJwk). ES256 signatures are DER.
 * @param {JsonWebKey} publicJwk @param {Uint8Array} signature @param {Uint8Array} signedData
 * @returns {Promise<boolean>}
 */
export async function verifyPasskeySignature(publicJwk, signature, signedData) {
  if (publicJwk?.kty === "EC" && publicJwk.crv === "P-256") {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y }, PASSKEY_ALGS[-7], false, ["verify"]);
    let raw;
    try { raw = derToRawEcdsa(signature, 32); } catch { return false; }
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signedData);
  }
  if (publicJwk?.kty === "OKP" && publicJwk.crv === "Ed25519") {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicJwk.x }, PASSKEY_ALGS[-8], false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, signature, signedData);
  }
  throw new StapleError("unsupported passkey key", "kid");
}

/**
 * HMAC-SHA-256 (RFC 2104): the pairwise Principal pseudonym, prn = "pw-" + base32(HMAC(k, aud)).
 * @param {Uint8Array} keyBytes @param {Uint8Array} data @returns {Promise<Uint8Array>}
 */
export async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
