// Diver identity: keys, diver_id, directory and card documents (spec §10.2, §10.3, §12).
//
// Root key   = identity. Never signs requests. Approves session keys, signs the card.
// Session key = exposure. Signs requests. Short-lived, rotated, memory only.
//
// "Accountability is fixed, exposure rotates."

import { HTTP_MESSAGE_SIGNATURES_DIRECTORY } from "web-bot-auth";
import { thumbprint } from "./thumbprint.mjs";
import { createHash, randomBytes, scrypt, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 (lowercase, no padding) */
export function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @returns {Promise<{ publicJwk: JsonWebKey, privateJwk: JsonWebKey, kid: string }>} */
export async function generateEd25519() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x };
  const kid = thumbprint(publicJwk); // RFC 7638 thumbprint, base64url (draft §5.2)
  return { publicJwk: { ...publicJwk, kid }, privateJwk: { ...publicJwk, d: priv.d, kid }, kid };
}

// ── Root keystore (spec §12.4, docs/adr/ADR-019) ──────────────────────────────────
// Outside dev mode the Root private key only ever exists on disk sealed: scrypt derives a
// key from the operator's passphrase, AES-256-GCM encrypts the 32-byte Ed25519 seed, and the
// public key + kid are the AAD, so a sealed blob cannot be moved under another identity.
// Both primitives are OpenSSL's, via node:crypto. KMS / OS keychain backends come later
// behind the same seal/open shape.

export const MIN_PASSPHRASE_LENGTH = 12;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };           // ~128 MiB, the OWASP scrypt baseline
const SCRYPT_LIMITS = { N: 2 ** 20, r: 16, p: 4 };   // refuse keystores that would DoS the opener
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The Ed25519 public key (JWK x) of a 32-byte seed, derived by OpenSSL. */
function publicXFromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ format: "jwk" }).x;
}

function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => scrypt(passphrase.normalize("NFKC"), salt, 32,
    { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}

const rootAad = (pub) => Buffer.from(`ludion-root-v1\n${JSON.stringify({ crv: pub.crv, kid: pub.kid, kty: pub.kty, x: pub.x })}`);

/** True when a stored Root is sealed (no private member present). */
export function isSealedRoot(root) {
  return !!root && typeof root === "object" && !("d" in root) && root.sealed?.v === 1;
}

/**
 * Seal a Root private JWK under a passphrase. The result carries the public key, its kid
 * (RFC 7638 thumbprint) and `sealed`; it has no private member.
 * @param {JsonWebKey} privateJwk @param {string} passphrase
 */
export async function sealRootKey(privateJwk, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`the Root passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  if (privateJwk?.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string") throw new Error("Root must be an Ed25519 private JWK");
  const seed = Buffer.from(privateJwk.d, "base64url");
  try {
    if (seed.length !== 32 || publicXFromSeed(seed) !== privateJwk.x) throw new Error("Root private key does not match its public key");
    const pub = { kty: "OKP", crv: "Ed25519", x: privateJwk.x };
    pub.kid = thumbprint(pub);
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = await deriveKey(passphrase, salt, SCRYPT);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(rootAad(pub));
    const ct = Buffer.concat([c.update(seed), c.final()]);
    const tag = c.getAuthTag();
    key.fill(0);
    const b = (x) => x.toString("base64url");
    return { ...pub, sealed: { v: 1, kdf: "scrypt", ...SCRYPT, salt: b(salt), cipher: "aes-256-gcm", iv: b(iv), ct: b(ct), tag: b(tag) } };
  } finally { seed.fill(0); }
}

/**
 * Open a sealed Root. Throws on a wrong passphrase, any tampering (ciphertext, tag, iv, salt,
 * public key or kid), or a key that does not match the public key it is stored under.
 * The returned private JWK lives in memory only.
 * @returns {Promise<JsonWebKey & { kid: string }>}
 */
export async function openRootKey(root, passphrase) {
  if (!isSealedRoot(root)) throw new Error("Root is not sealed");
  const s = root.sealed;
  if (s.kdf !== "scrypt" || s.cipher !== "aes-256-gcm") throw new Error("unsupported keystore");
  for (const k of ["N", "r", "p"]) if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > SCRYPT_LIMITS[k]) throw new Error("keystore parameters out of range");
  const pub = { kty: "OKP", crv: "Ed25519", x: root.x, kid: root.kid };
  if (root.kty !== "OKP" || root.crv !== "Ed25519" || thumbprint({ kty: "OKP", crv: "Ed25519", x: root.x }) !== root.kid) throw new Error("keystore public key and kid disagree");
  const key = await deriveKey(String(passphrase ?? ""), Buffer.from(s.salt, "base64url"), s);
  let seed;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64url"));
    d.setAAD(rootAad(pub));
    d.setAuthTag(Buffer.from(s.tag, "base64url"));
    seed = Buffer.concat([d.update(Buffer.from(s.ct, "base64url")), d.final()]);
  } catch { throw new Error("cannot open the Root keystore: wrong passphrase or the keystore was modified"); }
  finally { key.fill(0); }
  try {
    if (seed.length !== 32 || publicXFromSeed(seed) !== root.x) throw new Error("Root keystore holds a key that is not this Root");
    return { kty: "OKP", crv: "Ed25519", x: root.x, d: seed.toString("base64url"), kid: root.kid };
  } finally { seed.fill(0); }
}

/** diver_id = "dvr-" + base32(first 80 bits of SHA-256 JWK thumbprint of the Root public key) (spec §10.2). */
export function diverIdFromRoot(rootPublicJwk) {
  const canonical = JSON.stringify({ crv: rootPublicJwk.crv, kty: rootPublicJwk.kty, x: rootPublicJwk.x });
  const digest = createHash("sha256").update(canonical).digest();
  return `dvr-${base32(digest.subarray(0, 10))}`;
}

/**
 * The HTTP Message Signatures Directory (JWKS) served at
 * /.well-known/http-message-signatures-directory. Contains SESSION keys only —
 * the Root key never appears in the directory because it never signs requests.
 * kid MUST equal the thumbprint (draft §5.5).
 */
export function directoryDocument(sessionPublicJwks, { nbf, exp } = {}) {
  return {
    keys: sessionPublicJwks.map((k) => ({
      kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig",
      ...(nbf ? { nbf } : {}), ...(exp ? { exp } : {}),
    })),
  };
}

export const DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
export { HTTP_MESSAGE_SIGNATURES_DIRECTORY };

/**
 * Signature Agent Card = OAuth Client ID Metadata Document + web_bot_auth object
 * (draft-meunier-webbotauth-registry-03). Ludion's accountability fields live in
 * one top-level `ludion` object so any CIMD/Web Bot Auth consumer can ignore them.
 *
 * @param {{ origin: string, name: string, contacts: string[], about?: string, logo?: string,
 *           webBotAuth?: object, ludion?: { diver_id: string, registry?: string, root_kid?: string } }} x
 */
export function cardDocument(x) {
  const origin = new URL(x.origin).origin;
  return {
    client_id: `${origin}/card`,
    client_name: x.name,
    ...(x.about ? { client_uri: x.about } : {}),
    ...(x.logo ? { logo_uri: x.logo } : {}),
    contacts: x.contacts,
    jwks_uri: `${origin}${HTTP_MESSAGE_SIGNATURES_DIRECTORY}`,
    web_bot_auth: { trigger: "fetcher", ...(x.webBotAuth ?? {}) },
    ludion: { version: 0, ...(x.ludion ?? {}) },
  };
}
