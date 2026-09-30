// Request signing (spec §10.4, draft-ietf-webbotauth-httpsig-protocol-00 §5.2).
//
//   import { ludionFetch } from "@ludion/diver";
//   const res = await ludionFetch("https://shop.example/api/products?q=camera");
//
// Covered components:
//   always: @authority, "signature-agent";key=<label>
//   POST/PUT/PATCH/DELETE: @method, @path, content-digest (RFC 9530)
//   when present: ludion-staple, ludion-mandate (so they cannot be swapped)
// Params: created, expires (≤60s), keyid (JWK thumbprint), nonce, tag="web-bot-auth".

import { sign, generateNonce, HTTP_MESSAGE_SIGNATURE_TAG } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { createHash } from "node:crypto";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const DEFAULT_LIFETIME_S = 60;

/**
 * Create a Diver signer from a SESSION private JWK and the origin where its
 * directory is published (the Signature-Agent identifier).
 * @param {{ sessionPrivateJwk: JsonWebKey, signatureAgent: string, label?: string,
 *           staple?: () => (string|undefined), mandate?: () => (string|undefined),
 *           lifetimeS?: number, now?: () => number, cimd?: boolean }} x
 */
export async function createDiverSigner(x) {
  const signer = await signerFromJWK(x.sessionPrivateJwk);
  const label = x.label ?? "sig1";
  const agentUrl = new URL(x.signatureAgent);
  if (agentUrl.protocol !== "https:" && !x.insecureAllowHttp) throw new Error("signature-agent must be https");
  const lifetime = x.lifetimeS ?? DEFAULT_LIFETIME_S;
  const now = x.now ?? (() => Date.now());

  /**
   * Compute the headers to add to a request.
   * @param {{ method: string, url: string, headers?: Record<string,string>, body?: string|Uint8Array }} req
   * @returns {Promise<Record<string,string>>}
   */
  async function headersFor(req) {
    const method = req.method.toUpperCase();
    const headers = { ...(req.headers ?? {}) };
    // Dictionary form is mandatory for signers (draft §5.2.1). type=cimd points at the card.
    headers["signature-agent"] = x.cimd
      ? `${label}="${agentUrl.origin}/card";type=cimd`
      : `${label}="${agentUrl.origin}"`;
    const additional = [];
    if (STATE_CHANGING.has(method)) {
      additional.push("@method", "@path");
      if (req.body != null) {
        const bytes = typeof req.body === "string" ? new TextEncoder().encode(req.body) : req.body;
        headers["content-digest"] = `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;
        additional.push("content-digest");
      }
    }
    const staple = x.staple?.();
    if (staple) { headers["ludion-staple"] = staple; additional.push("ludion-staple"); }
    const mandate = x.mandate?.();
    if (mandate) { headers["ludion-mandate"] = mandate; additional.push("ludion-mandate"); }

    const created = new Date(now());
    const fields = await sign(
      { kind: "request", method, targetUri: req.url, fields: Object.entries(headers).map(([name, value]) => ({ name, value })) },
      { signer, label, signatureAgentKey: label, created, expires: new Date(created.getTime() + lifetime * 1000),
        nonce: generateNonce(), target: "@authority", additionalComponents: additional },
    );
    headers["signature-input"] = fields.signatureInput;
    headers["signature"] = fields.signature;
    return headers;
  }

  return { headersFor, keyid: signer.keyid, label, tag: HTTP_MESSAGE_SIGNATURE_TAG };
}

/**
 * fetch() with Web Bot Auth. Same signature as fetch(), plus a Diver signer.
 * @param {string|URL} input
 * @param {RequestInit & { body?: string|Uint8Array }} [init]
 * @param {{ signer: Awaited<ReturnType<typeof createDiverSigner>>, fetch?: typeof fetch }} ctx
 */
export async function ludionFetch(input, init = {}, ctx) {
  if (!ctx?.signer) throw new Error("ludionFetch needs { signer }");
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  const base = {};
  new Headers(init.headers ?? {}).forEach((v, k) => { base[k] = v; });
  const headers = await ctx.signer.headersFor({ method, url, headers: base, body: init.body });
  return (ctx.fetch ?? globalThis.fetch)(url, { ...init, method, headers });
}
