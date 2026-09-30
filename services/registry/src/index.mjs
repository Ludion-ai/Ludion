// @ludion/registry — the Registry v0 (spec §13): Diver registration, session-key approval, Staple
// issuance, revocation and the revocation stream.
//
//   GET  /.well-known/ludion-keys          the Registry's public keys (JWKS), pinned by Gates
//   POST /v0/divers                        register a Diver             (Root-signed statement)
//   POST /v0/divers/{id}/keys              approve session keys         (Root-signed statement)
//   POST /v0/divers/{id}/staple            issue a Staple               (RFC 9421, signed by an approved session key)
//   POST /v0/revocations                   revoke a Diver or some keys  (Root-signed statement)
//   GET  /v0/revocations?since=N           revocation entries after N   (each a Registry-signed JWS)
//   GET  /v0/revocations/stream            the same, live (SSE, Last-Event-ID / ?since=)
//   POST /v0/principals                    register a Principal's passkey
//   POST /v0/mandates                      issue a Mandate              (the Principal's passkey consent)
//   POST /v0/mandates/{jti}/revoke         withdraw it                  (the same Principal's passkey)
//
// Off the hot path (spec §9.1, invariants 7 and 8): no Gate ever asks the Registry about a request.
// Agents carry their state (Staples); Gates hold the Registry's public keys and the revocation list.
// The Registry never learns where an agent goes: no endpoint takes a site, a URL or a path, and a
// Staple is the same for every site (PRIV-3). What it stores is the Diver's public identity, the
// approved public session keys, and revocations; Staples are counted, not kept (spec §13.3).
//
// Mandates (spec §10.6) are the one place a site is named to the Registry: by the Principal, who
// consents with a passkey to a delegation for a site (or a category). The Registry keeps the
// Mandate's hash, whose it is, its Diver and its expiry — never the site, scope or limits (§13.3).
//
// Fetch API only (Request → Response): Node, workerd, Deno and Bun run the same code. Crypto: the
// Registry signs and verifies JWS, passkey signatures and pseudonyms through
// @ludion/gate-core/staple and checks request signatures through web-bot-auth; it holds no
// primitive of its own (CRY-1).

import { verify as verifyRequestSignature } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { verifyJws, importRegistryKey, signJws, issueStaple, hmacSha256 } from "@ludion/gate-core/staple";
import { MANDATE_TYP, SCOPES, CHARGE_SCOPE, DEFAULT_MANDATE_LIFETIME_S, MAX_MANDATE_LIFETIME_S, validLimits, audienceHost } from "@ludion/gate-core/mandate";
import { credentialFrom, verifyAssertion, challengeFor, fromB64u, ConsentError } from "./webauthn.mjs";

export const REGISTER_TYP = "ludion-register+jwt";
export const KEYS_TYP = "ludion-keys+jwt";
export const REVOKE_TYP = "ludion-revoke+jwt";
export const REVOCATION_TYP = "ludion-revocation+jwt";
/** Ballast v0 (spec §14): the three commitments an operator makes at registration. */
export const BALLAST_V0 = ["abuse_response_24h", "revocation_consent", "glass_consent"];

export const MANDATE_REQUEST_TYP = "ludion-mandate-request";
export const MANDATE_REVOKE_TYP = "ludion-mandate-revoke";

const MAX_STAPLE_LIFETIME_S = 3600;   // spec §10.5
const STATEMENT_SKEW_S = 300;         // Root statements must be fresh: a captured one cannot be replayed later
const CONSENT_HELD_S = 2 * STATEMENT_SKEW_S; // a consent's challenge is refused again for as long as its iat could pass
const MAX_REQUEST = 4096;
const MAX_MREV = 32;                  // revoked Mandates a Staple carries (it must stay under the Gate's 4 KiB)
const MAX_BODY = 16 * 1024;
const MAX_KEYS = 8;
const SIG_MAX_AGE_S = 60, SIG_SKEW_S = 30;

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 7638 thumbprint of an Ed25519 public JWK (WebCrypto digest: runtime-neutral). */
export async function okpThumbprint(k) {
  return b64u(await sha256(enc.encode(JSON.stringify({ crv: k.crv, kty: "OKP", x: k.x }))));
}
/** diver_id (spec §10.2): "dvr-" + base32 of the first 80 bits of the Root key's JWK thumbprint digest. */
export async function diverIdOf(root) {
  return `dvr-${base32((await sha256(enc.encode(JSON.stringify({ crv: root.crv, kty: "OKP", x: root.x })))).subarray(0, 10))}`;
}

const isEd25519Public = (k) => k && typeof k === "object" && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && /^[A-Za-z0-9_-]{43}$/.test(k.x) && !("d" in k);
const publicOf = (k) => ({ kty: "OKP", crv: "Ed25519", x: k.x });

class HttpError extends Error {
  constructor(status, error, detail) { super(detail ?? error); this.status = status; this.error = error; }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
});

/** Decode a compact JWS payload without verifying it (to find the key it claims). */
function peekPayload(compact) {
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(compact.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))); }
  catch { throw new HttpError(400, "bad_statement", "statement is not a compact JWS"); }
}

/** In-memory state, optionally persisted through `save(state)` after every change. */
export function createMemoryStore({ state, save } = {}) {
  const s = state ?? { divers: {}, revocations: [], seq: 0, stapleCount: 0 };
  s.divers ??= {}; s.revocations ??= []; s.seq ??= 0; s.stapleCount ??= 0;
  s.principals ??= {}; s.mandates ??= {}; s.consents ??= {};
  const persist = async () => { if (save) await save(s); };
  return {
    async getDiver(id) { return s.divers[id]; },
    async putDiver(id, rec) { s.divers[id] = rec; await persist(); },
    async getPrincipal(credentialId) { return Object.hasOwn(s.principals, credentialId) ? s.principals[credentialId] : undefined; },
    /** false if the credential is already registered (a key is never replaced). */
    async addPrincipal(rec) { if (Object.hasOwn(s.principals, rec.id)) return false; s.principals[rec.id] = rec; await persist(); return true; },
    async putPrincipal(rec) { s.principals[rec.id] = rec; await persist(); },
    async getMandate(jti) { return Object.hasOwn(s.mandates, jti) ? s.mandates[jti] : undefined; },
    async putMandate(jti, rec) { s.mandates[jti] = rec; await persist(); },
    /** Record a consent's challenge; false if it was already used (checked and set in one step). */
    async useConsent(challenge, untilS, nowS) {
      for (const [c, t] of Object.entries(s.consents)) if (t < nowS) delete s.consents[c];
      if (Object.hasOwn(s.consents, challenge)) return false;
      s.consents[challenge] = untilS;
      await persist();
      return true;
    },
    async appendRevocation(make) { const seq = ++s.seq; const entry = await make(seq); s.revocations.push(entry); await persist(); return entry; },
    async revocationsSince(seq) { return s.revocations.filter((e) => e.seq > seq); },
    async countStaple() { s.stapleCount++; await persist(); },
    get state() { return s; },
  };
}

/**
 * @param {{ key: JsonWebKey | { privateKey: CryptoKey, kid: string, publicJwk: JsonWebKey },
 *           issuer?: string, origin?: string, store?: ReturnType<typeof createMemoryStore>,
 *           now?: () => number, stapleLifetimeS?: number, sseRetryMs?: number, heartbeatMs?: number,
 *           contactsVerified?: boolean }} o
 *   key:     the Registry's signing key (private JWK, or an imported key). Made and held by a human
 *            in production; tests and `--dev-ephemeral-key` make throwaway ones.
 *   origin:  the Registry's own origin. Signed requests must cover this authority (cf. ADR-023).
 *   contactsVerified: development only — treat every registered contact as confirmed (D1).
 *   consentOrigin, rpId: where Principals consent with their passkeys (default https://ludion.ai,
 *            ludion.ai); an assertion made on any other page or for any other RP is refused.
 */
export async function createRegistry(o) {
  if (!o?.key) throw new Error("the Registry needs its signing key");
  const signing = o.key.privateKey ? o.key : await importRegistryKey(o.key);
  const issuer = o.issuer ?? "https://registry.ludion.ai";
  const consentOrigin = o.consentOrigin ?? "https://ludion.ai";
  const rpId = o.rpId ?? "ludion.ai";
  const now = o.now ?? (() => Date.now());
  const store = o.store ?? createMemoryStore();
  const lifetime = Math.min(o.stapleLifetimeS ?? MAX_STAPLE_LIFETIME_S, MAX_STAPLE_LIFETIME_S);
  const sseRetryMs = o.sseRetryMs ?? 2000;
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const expectedHost = o.origin ? new URL(o.origin).host : undefined;
  /** Open revocation streams: push(entry) → cleanup() */
  const subscribers = new Map();
  const nowS = () => Math.floor(now() / 1000);

  function fresh(iat) {
    if (!Number.isInteger(iat) || Math.abs(iat - nowS()) > STATEMENT_SKEW_S) throw new HttpError(400, "stale_statement", "statement iat is missing or not within 5 minutes of now");
  }
  async function readJson(request) {
    const text = await readBody(request);
    try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "bad_json"); }
  }
  async function readBody(request) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > MAX_BODY) throw new HttpError(413, "too_large");
    return new TextDecoder().decode(buf);
  }

  async function register(request) {
    const { statement } = await readJson(request);
    if (typeof statement !== "string") throw new HttpError(400, "bad_statement");
    const claimed = peekPayload(statement);
    if (!isEd25519Public(claimed.root)) throw new HttpError(400, "bad_root", "root must be an Ed25519 public JWK");
    let p;
    try { ({ payload: p } = await verifyJws(statement, claimed.root, { typ: REGISTER_TYP })); } catch (e) { throw new HttpError(401, "bad_signature", e.message); }
    fresh(p.iat);
    const id = await diverIdOf(p.root);
    if (p.sub !== id) throw new HttpError(400, "bad_subject", "sub must be the diver_id of the Root key");
    let agent;
    try { agent = new URL(p.signature_agent); } catch { throw new HttpError(400, "bad_signature_agent"); }
    if (agent.protocol !== "https:" || agent.username || agent.password) throw new HttpError(400, "bad_signature_agent", "signature_agent must be an https origin");
    const contacts = Array.isArray(p.contacts) ? p.contacts.filter((c) => typeof c === "string" && c.length < 256).slice(0, 5) : [];
    const commitments = Array.isArray(p.commitments) ? p.commitments.filter((c) => BALLAST_V0.includes(c)) : [];
    const prev = await store.getDiver(id);
    if (prev?.revoked) throw new HttpError(403, "revoked", "this Diver is revoked");
    if (prev && prev.registered_iat >= p.iat) return json(200, { diver_id: id, status: "active" });
    await store.putDiver(id, {
      ...(prev ?? { keys: [], keys_ts: 0, revoked_jkt: [], created: new Date(now()).toISOString() }),
      diver_id: id, root: publicOf(p.root), signature_agent: agent.origin,
      name: typeof p.name === "string" ? p.name.slice(0, 128) : undefined, contacts, commitments,
      contact_verified: !!o.contactsVerified, registered_iat: p.iat,
    });
    return json(prev ? 200 : 201, { diver_id: id, status: "active" });
  }

  async function diverOr404(id) {
    const rec = await store.getDiver(id);
    if (!rec) throw new HttpError(404, "unknown_diver");
    return rec;
  }

  async function approveKeys(id, request) {
    const rec = await diverOr404(id);
    const { statement } = await readJson(request);
    if (typeof statement !== "string") throw new HttpError(400, "bad_statement");
    let p;
    try { ({ payload: p } = await verifyJws(statement, rec.root, { typ: KEYS_TYP })); } catch (e) { throw new HttpError(401, "bad_signature", e.message); }
    fresh(p.iat);
    if (p.sub !== id) throw new HttpError(400, "bad_subject");
    if (rec.revoked) throw new HttpError(403, "revoked", "this Diver is revoked");
    // An older approval replayed must not roll the key set back. Ordered by `ts` (milliseconds).
    const ts = Number.isInteger(p.ts) ? p.ts : p.iat * 1000;
    if (ts <= rec.keys_ts) throw new HttpError(409, "stale_approval", "an approval at least as recent is already recorded");
    if (!Array.isArray(p.keys) || !p.keys.length || p.keys.length > MAX_KEYS || !p.keys.every(isEd25519Public)) throw new HttpError(400, "bad_keys", `keys must be 1..${MAX_KEYS} Ed25519 public JWKs`);
    const rootKid = await okpThumbprint(rec.root);
    const keys = [];
    for (const k of p.keys) {
      const kid = await okpThumbprint(k);
      if (kid === rootKid) throw new HttpError(400, "root_is_not_a_session_key", "the Root never signs requests (spec §10.3)");
      if (rec.revoked_jkt.includes(kid)) throw new HttpError(409, "key_revoked", `key ${kid} is revoked`);
      if (!keys.some((x) => x.kid === kid)) keys.push({ ...publicOf(k), kid });
    }
    await store.putDiver(id, { ...rec, keys, keys_ts: ts });
    return json(200, { diver_id: id, approved: keys.map((k) => k.kid) });
  }

  /** Authenticate an RFC 9421 (Web Bot Auth) request signed by one of the Diver's approved keys. */
  async function authenticate(request, rec, bodyText) {
    const url = new URL(request.url);
    if (expectedHost && url.host !== expectedHost) throw new HttpError(401, "invalid_signature", "signed for another authority");
    const fields = [];
    request.headers.forEach((value, name) => fields.push({ name, value }));
    const digest = request.headers.get("content-digest");
    const want = `sha-256=:${b64(await sha256(enc.encode(bodyText)))}:`;
    if (digest !== want) throw new HttpError(401, "invalid_signature", "content-digest missing or does not match the body");
    let sig;
    try {
      sig = await verifyRequestSignature({ kind: "request", method: request.method, targetUri: request.url, fields }, {
        algorithms: ["ed25519"], maxAge: SIG_MAX_AGE_S + SIG_SKEW_S, clockSkew: SIG_SKEW_S, now: new Date(now()),
        resolver: async (c) => {
          const k = rec.keys.find((x) => x.kid === c.keyid);
          if (!k) throw new Error("key not approved for this Diver");
          return verifierFromJWK(publicOf(k));
        },
        validate: (s) => {
          if (s.expires.getTime() - s.created.getTime() > SIG_MAX_AGE_S * 1000) return false;
          const names = s.components.map((c) => (typeof c === "string" ? c : c.name));
          return ["@method", "@path", "@authority", "content-digest"].every((n) => names.includes(n));
        },
      });
    } catch (e) { throw new HttpError(401, "invalid_signature", String(e?.cause?.message ?? e?.message ?? e)); }
    return sig.keyid;
  }

  function standing(rec) {
    const ballastActive = BALLAST_V0.every((c) => rec.commitments?.includes(c));
    return {
      depth: rec.contact_verified && ballastActive ? 1 : 0, // D1: keys + confirmed contact + Ballast v0 (spec §13.4)
      ballast: ballastActive ? { status: "active", tier: "b0", commitments: [...BALLAST_V0] } : { status: "none" },
      op: { verified: rec.contact_verified ? "email" : "none" },
    };
  }

  async function staple(id, request) {
    const rec = await diverOr404(id);
    const bodyText = await readBody(request);
    const keyid = await authenticate(request, rec, bodyText);
    let body;
    try { body = JSON.parse(bodyText || "{}"); } catch { throw new HttpError(400, "bad_json"); }
    const jkt = Array.isArray(body.jkt) ? [...new Set(body.jkt)] : [keyid];
    if (!jkt.includes(keyid)) throw new HttpError(400, "bad_cnf", "the Staple must be bound to the key that asked for it");
    if (jkt.length > MAX_KEYS || !jkt.every((k) => rec.keys.some((x) => x.kid === k))) throw new HttpError(400, "bad_cnf", "every bound key must be approved");
    const t = nowS();
    const revoked = !!rec.revoked || jkt.some((k) => rec.revoked_jkt.includes(k));
    // Mandates this Diver's Principals withdrew and that could still pass: every Gate hears of it
    // through the Staple within its lifetime, subscribed or not (as with revocation, ADR-025 §4).
    const mrev = (rec.mrev ?? []).filter((m) => m.exp + 60 > t).slice(-MAX_MREV).map((m) => m.jti);
    const payload = revoked
      ? { iss: issuer, sub: id, iat: t, exp: t + lifetime, depth: 0, ballast: { status: "suspended" }, revoked: true, cnf: { jkt } }
      : { iss: issuer, sub: id, iat: t, exp: t + lifetime, ...standing(rec), ...(mrev.length ? { mrev } : {}), cnf: { jkt } };
    payload.jti = `stp-${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
    const compact = await issueStaple(signing.privateKey, signing.kid, payload);
    await store.countStaple();
    return json(200, { staple: compact, iat: payload.iat, exp: payload.exp, revoked });
  }

  /** Revoke (a Root statement over HTTP, or the Registry operator in process). */
  async function applyRevocation(rec, { scope, jkt, reason }) {
    if (scope === "diver" && rec.revoked) return rec.revoked;
    const entry = await store.appendRevocation(async (seq) => {
      const payload = {
        iss: issuer, seq, sub: rec.diver_id, scope,
        jkt: scope === "keys" ? jkt : [...new Set([...rec.keys.map((k) => k.kid), ...(jkt ?? [])])],
        ...(scope === "diver" ? { agent: rec.signature_agent } : {}),
        reason, iat: nowS(),
      };
      return { seq, jws: await signJws(signing.privateKey, signing.kid, REVOCATION_TYP, payload) };
    });
    const latest = await store.getDiver(rec.diver_id);
    const revokedJkt = [...new Set([...latest.revoked_jkt, ...(scope === "keys" ? jkt : latest.keys.map((k) => k.kid))])];
    await store.putDiver(rec.diver_id, {
      ...latest, revoked_jkt: revokedJkt,
      keys: scope === "keys" ? latest.keys.filter((k) => !jkt.includes(k.kid)) : latest.keys,
      ...(scope === "diver" ? { revoked: { seq: entry.seq, reason } } : {}),
    });
    for (const push of subscribers.keys()) push(entry);
    return { seq: entry.seq, reason };
  }

  async function revokeHttp(request) {
    const { statement } = await readJson(request);
    if (typeof statement !== "string") throw new HttpError(400, "bad_statement");
    const claimed = peekPayload(statement);
    const rec = await diverOr404(typeof claimed.sub === "string" ? claimed.sub : "");
    let p;
    try { ({ payload: p } = await verifyJws(statement, rec.root, { typ: REVOKE_TYP })); } catch (e) { throw new HttpError(401, "bad_signature", e.message); }
    fresh(p.iat);
    const scope = p.scope === "keys" ? "keys" : "diver";
    const jkt = Array.isArray(p.jkt) ? p.jkt.filter((k) => typeof k === "string" && /^[A-Za-z0-9_-]{43}$/.test(k)).slice(0, MAX_KEYS) : [];
    if (scope === "keys" && !jkt.length) throw new HttpError(400, "bad_keys", "a key revocation names the keys");
    const reason = ["compromised", "retired", "superseded"].includes(p.reason) ? p.reason : "unspecified";
    const r = await applyRevocation(rec, { scope, jkt, reason });
    return json(200, { diver_id: rec.diver_id, scope, seq: r.seq });
  }

  function sinceOf(request) {
    const url = new URL(request.url);
    const a = Number(request.headers.get("last-event-id") ?? NaN), b = Number(url.searchParams.get("since") ?? NaN);
    return Math.max(Number.isInteger(a) && a >= 0 ? a : 0, Number.isInteger(b) && b >= 0 ? b : 0);
  }

  async function revocationList(request) {
    const entries = await store.revocationsSince(sinceOf(request));
    return json(200, { seq: store.state?.seq ?? entries.at(-1)?.seq ?? 0, entries: entries.map((e) => e.jws) }, { "cache-control": "max-age=10" });
  }

  function revocationStream(request) {
    const since = sinceOf(request);
    let push, heartbeat, closed = false;
    const frame = (e) => enc.encode(`id: ${e.seq}\nevent: revocation\ndata: ${e.jws}\n\n`);
    const body = new ReadableStream({
      async start(controller) {
        const cleanup = () => { if (closed) return; closed = true; subscribers.delete(push); clearInterval(heartbeat); try { controller.close(); } catch { /* closed */ } };
        let lastSent = since;
        const queue = [];
        let backlogDone = false;
        push = (e) => {
          if (closed) return;
          if (!backlogDone) { queue.push(e); return; }
          if (e.seq > lastSent) { lastSent = e.seq; try { controller.enqueue(frame(e)); } catch { cleanup(); } }
        };
        subscribers.set(push, cleanup); // before reading the backlog, so nothing falls between the two
        controller.enqueue(enc.encode(`retry: ${sseRetryMs}\n\n`));
        for (const e of await store.revocationsSince(since)) if (e.seq > lastSent) { lastSent = e.seq; controller.enqueue(frame(e)); }
        backlogDone = true;
        for (const e of queue.splice(0)) push(e);
        heartbeat = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch { cleanup(); } }, heartbeatMs);
        heartbeat.unref?.();
        request.signal?.addEventListener?.("abort", cleanup);
      },
      cancel() { closed = true; subscribers.delete(push); clearInterval(heartbeat); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }

  // ── Principals and Mandates (spec §10.6) ─────────────────────────────────────────────────

  async function registerPrincipal(request) {
    const { credential } = await readJson(request);
    let cred;
    try { cred = await credentialFrom(credential); } catch (e) { throw new HttpError(400, "bad_credential", e.message); }
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    // k is the Principal's pseudonym key: prn = "pw-" + base32(HMAC(k, aud)) differs per site (spec §10.2).
    const added = await store.addPrincipal({ id: cred.id, alg: cred.alg, jwk: cred.jwk, sign_count: 0, k: b64u(k), created: new Date(now()).toISOString() });
    if (!added) throw new HttpError(409, "credential_exists", "this passkey is already registered; a registered key is never replaced");
    return json(201, { credential_id: cred.id });
  }

  /**
   * A consented request: `request` is the exact text the passkey approved (its SHA-256 is the
   * challenge). Returns the parsed request and the Principal, the assertion checked and spent.
   */
  async function consented(body, typ) {
    const { request: text, assertion } = body;
    if (typeof text !== "string" || text.length > MAX_REQUEST) throw new HttpError(400, "bad_request", "request must be the consented JSON text");
    let req;
    try { req = JSON.parse(text); } catch { throw new HttpError(400, "bad_request", "request is not JSON"); }
    if (!req || typeof req !== "object" || req.typ !== typ) throw new HttpError(400, "bad_request", `request typ must be ${typ}`);
    if (!Number.isInteger(req.iat) || Math.abs(req.iat - nowS()) > STATEMENT_SKEW_S) throw new HttpError(400, "stale_request", "request iat is missing or not within 5 minutes of now");
    if (typeof req.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(req.nonce)) throw new HttpError(400, "bad_request", "request nonce must be 16..128 base64url characters");
    const principal = typeof assertion?.credential_id === "string" ? await store.getPrincipal(assertion.credential_id) : undefined;
    if (!principal) throw new HttpError(401, "unknown_credential", "no Principal has registered this passkey");
    return { req, text, assertion, principal };
  }

  async function spend({ text, assertion, principal, req }) {
    let signCount;
    try { ({ signCount } = await verifyAssertion(assertion, { credential: principal, requestText: text, rpId, origin: consentOrigin, signCount: principal.sign_count })); }
    catch (e) { throw new HttpError(401, "bad_consent", e instanceof ConsentError ? e.message : "assertion could not be checked"); }
    if (!await store.useConsent(await challengeFor(text), req.iat + CONSENT_HELD_S, nowS())) throw new HttpError(409, "consent_replayed", "this consent was already used");
    await store.putPrincipal({ ...(await store.getPrincipal(principal.id)), sign_count: signCount });
  }

  async function issueMandate(request) {
    const c = await consented(await readJson(request), MANDATE_REQUEST_TYP);
    const { req } = c;
    const diver = typeof req.sub === "string" ? await store.getDiver(req.sub) : undefined;
    if (!diver) throw new HttpError(404, "unknown_diver", "sub must be a registered Diver");
    if (diver.revoked) throw new HttpError(403, "revoked", "this Diver is revoked");
    if (typeof req.aud !== "string" || (audienceHost(req.aud) == null && !/^cat:[a-z0-9-]{1,32}$/.test(req.aud))) {
      throw new HttpError(400, "bad_audience", 'aud must be a site origin ("https://shop.example") or a category ("cat:ecommerce")');
    }
    if (!Array.isArray(req.scope) || !req.scope.length || !req.scope.every((s) => SCOPES.includes(s)) || new Set(req.scope).size !== req.scope.length) {
      throw new HttpError(400, "bad_scope", `scope must be distinct words from ${SCOPES.join(", ")}`);
    }
    let limits;
    if (req.limits != null) {
      if (typeof req.limits !== "object" || Array.isArray(req.limits) || Object.keys(req.limits).some((k) => !["checkout_max", "currency", "per_day"].includes(k))) {
        throw new HttpError(400, "bad_limits", "limits may hold checkout_max, currency and per_day only");
      }
      if (!validLimits(req.limits) || (req.limits.per_day != null && req.limits.per_day > 1000)) throw new HttpError(400, "bad_limits", "checkout_max: a positive integer in the currency's minor unit; currency: ISO 4217; per_day: 1..1000");
      limits = { checkout_max: req.limits.checkout_max, currency: req.limits.currency, ...(req.limits.per_day != null ? { per_day: req.limits.per_day } : {}) };
    }
    if (req.scope.includes(CHARGE_SCOPE) && !limits) throw new HttpError(400, "bad_limits", "a checkout Mandate carries its limits (spec §10.6)");
    const t = nowS();
    const exp = req.exp == null ? t + DEFAULT_MANDATE_LIFETIME_S : req.exp;
    if (!Number.isInteger(exp) || exp <= t || exp - t > MAX_MANDATE_LIFETIME_S) throw new HttpError(400, "bad_expiry", "exp must be in the future and at most 7 days away");
    await spend(c);

    const prn = `pw-${base32(await hmacSha256(fromB64u(c.principal.k), enc.encode(req.aud)))}`;
    const jti = `mdt-${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
    const payload = { iss: issuer, sub: req.sub, prn, aud: req.aud, scope: [...req.scope], ...(limits ? { limits } : {}), iat: t, exp, jti };
    const compact = await signJws(signing.privateKey, signing.kid, MANDATE_TYP, payload);
    // Kept: the hash, whose it is, its Diver and expiry. Not the site, the scope or the limits.
    await store.putMandate(jti, { h: b64u(await sha256(enc.encode(compact))), principal: c.principal.id, sub: req.sub, exp });
    return json(201, { mandate: compact, jti, exp });
  }

  async function revokeMandate(jti, request) {
    const c = await consented(await readJson(request), MANDATE_REVOKE_TYP);
    if (c.req.jti !== jti) throw new HttpError(400, "bad_request", "the consented request names another Mandate");
    const rec = await store.getMandate(jti);
    if (!rec) throw new HttpError(404, "unknown_mandate");
    await spend(c);
    if (rec.principal !== c.principal.id) throw new HttpError(403, "not_your_mandate", "only the Principal who gave a Mandate can withdraw it");
    if (rec.revoked) return json(200, { jti, seq: rec.revoked.seq });
    const entry = await store.appendRevocation(async (seq) => ({
      seq, jws: await signJws(signing.privateKey, signing.kid, REVOCATION_TYP, { iss: issuer, seq, sub: rec.sub, scope: "mandate", mdt: [jti], reason: "withdrawn", iat: nowS() }),
    }));
    await store.putMandate(jti, { ...rec, revoked: { seq: entry.seq } });
    const diver = await store.getDiver(rec.sub);
    if (diver) {
      const t = nowS();
      await store.putDiver(rec.sub, { ...diver, mrev: [...(diver.mrev ?? []).filter((m) => m.exp + 60 > t), { jti, exp: rec.exp }] });
    }
    for (const push of subscribers.keys()) push(entry);
    return json(200, { jti, seq: entry.seq });
  }

  async function route(request) {
    const url = new URL(request.url);
    const m = request.method;
    const p = url.pathname;
    if (m === "GET" && p === "/.well-known/ludion-keys") return json(200, { keys: [signing.publicJwk] }, { "cache-control": "max-age=3600" });
    if (m === "POST" && p === "/v0/divers") return register(request);
    let r = /^\/v0\/divers\/(dvr-[a-z2-7]{16})\/(keys|staple)$/.exec(p);
    if (r && m === "POST") return r[2] === "keys" ? approveKeys(r[1], request) : staple(r[1], request);
    if (m === "POST" && p === "/v0/revocations") return revokeHttp(request);
    if (m === "GET" && p === "/v0/revocations") return revocationList(request);
    if (m === "GET" && p === "/v0/revocations/stream") return revocationStream(request);
    if (m === "POST" && p === "/v0/principals") return registerPrincipal(request);
    if (m === "POST" && p === "/v0/mandates") return issueMandate(request);
    const mr = /^\/v0\/mandates\/(mdt-[A-Za-z0-9_-]{8,64})\/revoke$/.exec(p);
    if (mr && m === "POST") return revokeMandate(mr[1], request);
    if (["/v0/divers", "/v0/revocations", "/v0/revocations/stream", "/.well-known/ludion-keys", "/v0/principals", "/v0/mandates"].includes(p) || r || mr) throw new HttpError(405, "method_not_allowed");
    throw new HttpError(404, "not_found");
  }

  return {
    async fetch(request) {
      try { return await route(request); }
      catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.error, ...(e.message !== e.error ? { detail: e.message } : {}) });
        return json(500, { error: "internal" });
      }
    },
    /** The Registry operator revokes a Diver (abuse, a broken commitment), in process. */
    async revoke(diverId, { reason = "unspecified" } = {}) {
      const rec = await store.getDiver(diverId);
      if (!rec) throw new Error(`unknown diver ${diverId}`);
      return applyRevocation(rec, { scope: "diver", jkt: [], reason });
    },
    /** Development: mark a Diver's contact as confirmed (the email loop is not built yet). */
    async confirmContact(diverId) {
      const rec = await store.getDiver(diverId);
      if (!rec) throw new Error(`unknown diver ${diverId}`);
      await store.putDiver(diverId, { ...rec, contact_verified: true });
    },
    publicKeys: { keys: [signing.publicJwk] },
    issuer,
    /** End every open revocation stream (graceful shutdown). */
    close() { for (const cleanup of [...subscribers.values()]) cleanup(); },
    store,
  };
}
