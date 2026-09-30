// A software passkey and a Principal (tests only; spec §10.6 allows the passkey to be simulated in
// tests). The authenticator does what a platform authenticator does for navigator.credentials.get,
// byte for byte: clientDataJSON, authenticatorData (rpIdHash, UP|UV, a signature counter), and a
// signature over authenticatorData ‖ SHA-256(clientDataJSON) — ES256 in DER, or EdDSA. Every knob
// can be bent so a negative test differs from a good consent in exactly one way.
import { createHash, randomBytes } from "node:crypto";
import { MANDATE_REQUEST_TYP, MANDATE_REVOKE_TYP } from "../src/index.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** r‖s (WebCrypto) → DER ECDSA-Sig-Value (WebAuthn). */
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : Buffer.from(b);
  };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
}

/**
 * @param {{ alg?: -7|-8, rpId?: string, origin?: string, counting?: boolean }} [o]
 *   counting: a signature counter that advances (true) or stays 0 (many synced passkeys)
 */
export async function softPasskey({ alg = -7, rpId = "ludion.ai", origin = "https://ludion.ai", counting = true } = {}) {
  const algorithm = alg === -7 ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
  const kp = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const id = b64u(randomBytes(32));
  let counter = 0;
  return {
    credential: { id, public_key: b64u(spki), alg },
    /**
     * The assertion navigator.credentials.get would return for this challenge.
     * @param {string} requestText  the exact text consented to (challenge = SHA-256 of it)
     * @param {object} [bend]  { type, origin, rpId, flags, signCount, challenge, crossOrigin, signWith, id }
     */
    async assert(requestText, bend = {}) {
      const clientData = JSON.stringify({
        type: bend.type ?? "webauthn.get", challenge: bend.challenge ?? b64u(sha256(requestText)),
        origin: bend.origin ?? origin, crossOrigin: bend.crossOrigin ?? false,
      });
      if (counting) counter++;
      const count = bend.signCount ?? counter;
      const ad = Buffer.alloc(37);
      sha256(bend.rpId ?? rpId).copy(ad, 0);
      ad[32] = bend.flags ?? 0x05; // UP | UV
      ad.writeUInt32BE(count, 33);
      const signed = Buffer.concat([ad, sha256(clientData)]);
      const key = bend.signWith ?? kp.privateKey;
      const sig = alg === -7
        ? rawToDer(Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed)))
        : Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, key, signed));
      return { credential_id: bend.id ?? id, authenticator_data: b64u(ad), client_data_json: b64u(clientData), signature: b64u(sig) };
    },
    /** Another key of the same kind: a signature it makes is not this credential's. */
    async otherKey() { return (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])).privateKey; },
  };
}

/**
 * A Principal on the consent page: registers a passkey, consents to Mandates, withdraws them.
 * @param {{ registryUrl: string, now: () => number, passkey: Awaited<ReturnType<typeof softPasskey>> }} o
 */
export function principal({ registryUrl, now, passkey }) {
  const post = async (path, body) => {
    const res = await fetch(`${registryUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const iat = () => Math.floor(now() / 1000);
  const nonce = () => b64u(randomBytes(16));
  return {
    passkey,
    register: () => post("/v0/principals", { credential: passkey.credential }),
    /** The request text and its assertion: what the consent page sends. `bend` bends the assertion. */
    async consent(fields, { typ = MANDATE_REQUEST_TYP, bend, edit } = {}) {
      const request = JSON.stringify({ typ, ...fields, iat: fields.iat ?? iat(), nonce: fields.nonce ?? nonce() });
      const assertion = await passkey.assert(request, bend);
      return { request: edit ? edit(request) : request, assertion };
    },
    /** Consent to a Mandate and have it issued: { status, body: { mandate, jti, exp } | { error } }. */
    async mandate(fields, o) { return post("/v0/mandates", await this.consent(fields, o)); },
    /** Post an already made consent (to replay it). */
    send: (consent) => post("/v0/mandates", consent),
    async revoke(jti, o = {}) { return post(`/v0/mandates/${o.path ?? jti}/revoke`, await this.consent({ jti }, { typ: MANDATE_REVOKE_TYP, ...o })); },
  };
}
