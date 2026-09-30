// Passkey consent (spec §10.6, §13.2): the Principal approves one exact request on the consent
// page with a passkey. What the Registry checks of a WebAuthn assertion (WebAuthn Level 3 §7.2):
//
//   clientDataJSON  type "webauthn.get", challenge = base64url(SHA-256(the request's bytes)),
//                   origin = the consent page's origin, not cross-origin
//   authenticatorData  rpIdHash = SHA-256(rpId), User Present and User Verified set,
//                   signCount moving forward (when the authenticator counts)
//   signature       over authenticatorData ‖ SHA-256(clientDataJSON), by the credential's key
//
// The challenge is the hash of the request itself, so an assertion approves those bytes and
// nothing else; the Registry refuses a challenge it has seen (single use) and a request whose iat
// is not within 5 minutes of now. Registration takes the public key as the browser hands it over
// (getPublicKey(): SubjectPublicKeyInfo, with getPublicKeyAlgorithm()); no attestation in v0.
//
// Parsing and policy only: the signature is checked by @ludion/gate-core/staple (CRY-1).

import { passkeyPublicJwk, verifyPasskeySignature } from "@ludion/gate-core/staple";

const enc = new TextEncoder();
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromB64u(s, max = 4096) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > Math.ceil((max * 4) / 3)) throw new ConsentError("not base64url");
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export class ConsentError extends Error {
  constructor(message) { super(message); this.name = "ConsentError"; }
}

/** The challenge a consent to `requestText` must carry. */
export async function challengeFor(requestText) {
  return b64u(await sha256(enc.encode(requestText)));
}

/**
 * A passkey credential as registered: { id, alg, jwk }.
 * @param {{ id: string, public_key: string, alg: number }} c  id and SPKI in base64url, COSE alg
 */
export async function credentialFrom(c) {
  if (!c || typeof c !== "object") throw new ConsentError("credential required");
  const id = fromB64u(c.id, 1023);
  if (id.length < 16) throw new ConsentError("credential id too short");
  if (c.alg !== -7 && c.alg !== -8) throw new ConsentError("passkey algorithm must be ES256 (-7) or EdDSA (-8)");
  let jwk;
  try { jwk = await passkeyPublicJwk(fromB64u(c.public_key, 512), c.alg); } catch (e) { throw new ConsentError(e.message); }
  return { id: b64u(id), alg: c.alg, jwk };
}

/**
 * Verify one assertion for `requestText` under `credential`.
 * @param {{ credential_id: string, authenticator_data: string, client_data_json: string, signature: string }} a
 * @param {{ credential: { id: string, jwk: JsonWebKey }, requestText: string, rpId: string, origin: string, signCount: number }} o
 * @returns {Promise<{ signCount: number }>}
 */
export async function verifyAssertion(a, o) {
  if (!a || typeof a !== "object") throw new ConsentError("assertion required");
  if (a.credential_id !== o.credential.id) throw new ConsentError("assertion made with another credential");
  const clientDataJSON = fromB64u(a.client_data_json, 2048);
  let cd;
  try { cd = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientDataJSON)); } catch { throw new ConsentError("clientDataJSON is not JSON"); }
  if (cd?.type !== "webauthn.get") throw new ConsentError("not an assertion (clientData.type)");
  if (cd.challenge !== await challengeFor(o.requestText)) throw new ConsentError("the assertion approves other bytes (challenge)");
  if (cd.origin !== o.origin) throw new ConsentError("made on another page (clientData.origin)");
  if (cd.crossOrigin === true) throw new ConsentError("made in a cross-origin frame");

  const ad = fromB64u(a.authenticator_data, 1024);
  if (ad.length < 37) throw new ConsentError("authenticatorData too short");
  const rpIdHash = await sha256(enc.encode(o.rpId));
  if (!ad.subarray(0, 32).every((b, i) => b === rpIdHash[i])) throw new ConsentError("made for another relying party (rpIdHash)");
  const flags = ad[32];
  if (!(flags & 0x01)) throw new ConsentError("user not present (UP)");
  if (!(flags & 0x04)) throw new ConsentError("user not verified (UV)");
  const signCount = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;
  if ((signCount !== 0 || o.signCount !== 0) && signCount <= o.signCount) throw new ConsentError("signature counter did not advance (a cloned authenticator?)");

  const signed = new Uint8Array(ad.length + 32);
  signed.set(ad); signed.set(await sha256(clientDataJSON), ad.length);
  let ok = false;
  try { ok = await verifyPasskeySignature(o.credential.jwk, fromB64u(a.signature, 256), signed); } catch { ok = false; }
  if (!ok) throw new ConsentError("passkey signature invalid");
  return { signCount };
}
