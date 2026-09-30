// Diver identity: keys, diver_id, directory and card documents (spec §10.2, §10.3, §12).
//
// Root key   = identity. Never signs requests. Approves session keys, signs the card.
// Session key = exposure. Signs requests. Short-lived, rotated, memory only.
//
// "Accountability is fixed, exposure rotates."

import { HTTP_MESSAGE_SIGNATURES_DIRECTORY } from "web-bot-auth";
import { thumbprint } from "./thumbprint.mjs";
import { createHash } from "node:crypto";

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
