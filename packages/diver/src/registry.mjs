// Talking to the Ludion Registry (spec §13): register, approve session keys, fetch Staples, revoke.
//
// What the Registry hears from a Diver is its own identity and nothing else: the Root's public key,
// the Signature-Agent origin, contacts, public session keys, and a signed "give me a Staple". No
// call takes a site, a URL or a path, and a Staple is fetched on a timer, not because of a request
// (spec §10.5: the Registry never learns where an agent goes; PRIV-3).
//
// The Root signs statements (registration, key approval, revocation); a session key signs the
// Staple request (RFC 9421, like any other request, but to the Registry and with no Staple).

import { createDiverSigner } from "./sign.mjs";
import { signRootStatement } from "./keys.mjs";
import { BALLAST_V0 } from "./ballast.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const publicOf = (k) => ({ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid });

export class RegistryError extends Error {
  constructor(status, body) { super(`registry: ${status} ${body?.error ?? ""}${body?.detail ? ` — ${body.detail}` : ""}`); this.status = status; this.error = body?.error; }
}

/**
 * @param {{ url: string, fetch?: typeof fetch, now?: () => number }} o
 *   url: the Registry's origin (https; http only on loopback, for development and tests)
 */
export function createRegistryClient({ url, fetch = globalThis.fetch, now = () => Date.now() }) {
  const base = new URL(url);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.has(base.hostname))) throw new Error("the Registry URL must be https");
  const origin = base.origin;
  const iat = () => Math.floor(now() / 1000);
  let lastTs = 0;

  async function post(path, body, headers = { "content-type": "application/json" }) {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers, body, redirect: "manual" });
    let json;
    try { json = await res.json(); } catch { json = {}; }
    if (res.status >= 300) throw new RegistryError(res.status, json);
    return json;
  }

  return {
    origin,
    /** Register the Diver (Root-signed). Idempotent. */
    async register(store, rootPrivateJwk, { commitments = BALLAST_V0 } = {}) {
      const statement = signRootStatement(rootPrivateJwk, "ludion-register+jwt", {
        sub: store.diver_id, root: { kty: "OKP", crv: "Ed25519", x: rootPrivateJwk.x },
        signature_agent: store.signature_agent, name: store.name, contacts: store.contacts, commitments, iat: iat(),
      });
      return post("/v0/divers", JSON.stringify({ statement }));
    },
    /** Approve the session keys the Diver may sign with (Root-signed; replaces the approved set). */
    async approveKeys(store, rootPrivateJwk, keys) {
      // ts (ms) orders approvals: the Registry refuses one not newer than the last it recorded.
      const ts = Math.max(Math.floor(now()), lastTs + 1);
      lastTs = ts;
      const statement = signRootStatement(rootPrivateJwk, "ludion-keys+jwt", { sub: store.diver_id, keys: keys.map(publicOf), iat: Math.floor(ts / 1000), ts });
      return post(`/v0/divers/${store.diver_id}/keys`, JSON.stringify({ statement }));
    },
    /**
     * Fetch a Staple bound to `sessionPrivateJwk` (and optionally more approved keys), authenticated
     * by that key's signature. Carries the Diver's own identity only.
     */
    async staple(store, sessionPrivateJwk, { jkt } = {}) {
      const signer = await createDiverSigner({ sessionPrivateJwk, signatureAgent: store.signature_agent, now });
      const target = `${origin}/v0/divers/${store.diver_id}/staple`;
      const body = JSON.stringify({ jkt: jkt ?? [sessionPrivateJwk.kid] });
      const headers = await signer.headersFor({ method: "POST", url: target, headers: { "content-type": "application/json" }, body });
      return post(`/v0/divers/${store.diver_id}/staple`, body, headers);
    },
    /** Revoke the whole Diver, or only some session keys (`jkt`) (Root-signed). */
    async revoke(store, rootPrivateJwk, { jkt, reason = "compromised" } = {}) {
      const statement = signRootStatement(rootPrivateJwk, "ludion-revoke+jwt", {
        sub: store.diver_id, scope: jkt?.length ? "keys" : "diver", ...(jkt?.length ? { jkt } : {}), reason, iat: iat(),
      });
      return post("/v0/revocations", JSON.stringify({ statement }));
    },
  };
}

/**
 * Keep a fresh Staple for a session key: fetched at start, refetched at half its lifetime (spec
 * §10.5), on a timer, whatever the agent is doing. `current()` never waits and never calls out.
 * @param {{ client: ReturnType<typeof createRegistryClient>, store: object, sessionPrivateJwk: JsonWebKey,
 *           now?: () => number, onStaple?: (s: object) => void, onError?: (e: Error) => void }} o
 */
export function createStapleKeeper(o) {
  const now = o.now ?? (() => Date.now());
  let current, timer, stopped = false;
  async function refresh() {
    const s = await o.client.staple(o.store, o.sessionPrivateJwk);
    current = s;
    o.onStaple?.(s);
    return s;
  }
  function schedule() {
    if (stopped || !current) return;
    const halfMs = Math.max(1000, ((current.exp - current.iat) * 1000) / 2);
    const due = current.iat * 1000 + halfMs - now();
    timer = setTimeout(() => refresh().then(schedule, (e) => { o.onError?.(e); timer = setTimeout(schedule, 30_000); timer.unref?.(); }), Math.max(0, due));
    timer.unref?.();
  }
  return {
    /** The Staple to attach while it is valid (a revoked one too: an honest agent carries what the Registry said). */
    current() { return current && current.exp * 1000 > now() ? current.staple : undefined; },
    refresh,
    async start() { await refresh(); schedule(); return current; },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
