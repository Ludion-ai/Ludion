// Glass: signed receipts and metadata events (spec §10.9, §11.7).
//
// What leaves the site (only if report.send_metadata is true, default off in v0):
//   time, route TEMPLATE, method, class, decision, pressure, diver/identifier,
//   country (if the host supplies it), salted hash of the TRUNCATED IP
//   (IPv4 /24, IPv6 /48). Never: bodies, cookies, query values, other headers.
//
// Receipts are signed with the site's own Ed25519 key (WebCrypto). Both the
// site and the agent hold the same receipt, so neither can later deny it.

import { createHash, randomBytes } from "node:crypto";
import { templatePath } from "./route.mjs";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

/** Generate a site key (Ed25519). Store the private JWK where the site keeps secrets. */
export async function generateSiteKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const kid = b64u(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: publicJwk.x })).digest());
  return { kid, publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid }, privateJwk: { ...privateJwk, kid } };
}

export async function importSiteKey(privateJwk) {
  const { d, x } = privateJwk;
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d, x }, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, true, ["verify"]);
  const kid = privateJwk.kid ?? b64u(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest());
  return { kid, privateKey, publicKey };
}

// Route templating lives in route.mjs (shared with `ludion scan`); re-exported for callers.
export { templatePath };

/** IP truncation + salted hash (spec §11.7). */
export function hashIp(ip, salt) {
  if (!ip) return null;
  let t;
  if (ip.includes(":")) { // IPv6 → /48
    const parts = ip.split(":");
    t = parts.slice(0, 3).join(":") + "::/48";
  } else {
    const p = ip.split(".");
    t = `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  return b64u(createHash("sha256").update(salt).update(t).digest()).slice(0, 22);
}

/** Canonical JSON: sorted keys, no whitespace. Enough for signing our own flat objects. */
export function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  if (obj && typeof obj === "object") {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

export function createReceipts({ siteId, siteKey, now = () => Date.now() }) {
  return {
    /**
     * @param {{ method: string, path: string, cls: any, decision: any, pressure: number,
     *           signatureInput?: string, signature?: string }} x
     */
    async issue(x) {
      const body = {
        v: 0,
        rid: `rcp-${b64u(randomBytes(12))}`,
        site: siteId,
        diver: x.cls.diverId ?? x.cls.identifier ?? null,
        ts: Math.floor(now() / 1000),
        method: x.method,
        route: templatePath(x.path),
        class: x.cls.class,
        decision: x.decision.action,
        error: x.decision.error ?? null,
        pressure: x.pressure,
        req_digest: x.signature ? `sha-256=:${createHash("sha256").update(x.signature).digest("base64")}:` : null,
        kid: siteKey.kid,
      };
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, siteKey.privateKey, new TextEncoder().encode(canonical(body))));
      return { ...body, sig: b64u(sig) };
    },
    /** Compact header form: base64url(JSON). */
    toHeader(receipt) { return b64u(new TextEncoder().encode(JSON.stringify(receipt))); },
    async verify(receipt, publicKey) {
      const { sig, ...body } = receipt;
      return crypto.subtle.verify({ name: "Ed25519" }, publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(canonical(body)));
    },
  };
}

/** Metadata event for Ludion Cloud (spec §11.7). Strictly no content. */
export function metadataEvent({ receipt, ip, ipSalt, country }) {
  return {
    v: 0,
    rid: receipt.rid, site: receipt.site, ts: receipt.ts,
    method: receipt.method, route: receipt.route,
    class: receipt.class, decision: receipt.decision, error: receipt.error, pressure: receipt.pressure,
    diver: receipt.diver,
    country: country ?? null,
    ip_h: hashIp(ip, ipSalt),
  };
}
