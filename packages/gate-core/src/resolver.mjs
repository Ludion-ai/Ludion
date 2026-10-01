// Key discovery for Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol-00).
//
// Threats handled here (spec §15.2, draft §6.7 / §6.10 / App. C):
//   - SSRF via attacker-controlled Signature-Agent URL: https only, no redirects,
//     private/loopback/link-local IP literals refused, byte limit, key-count
//     limit, wall-clock timeout, per-URL fetch coalescing.
//   - Key confusion: lookup is keyed on the (URL, keyid) PAIR (draft §5.4).
//   - Outage-as-revocation: a failed fetch never evicts a cached directory
//     (draft §6.10). Negative cache is bounded to 5 minutes (App. C.5).
//
// The resolver never sees request bodies, cookies or the site's content. It
// only ever fetches public key material.

import { verifierFromJWK } from "web-bot-auth/crypto";
import { parseSignatureAgentCard, HTTP_MESSAGE_SIGNATURES_DIRECTORY } from "web-bot-auth";
import { thumbprint } from "./thumbprint.mjs";
import { isPublicAddress, isIpLiteral } from "./address.mjs";

export class DiscoveryError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) { super(message); this.name = "DiscoveryError"; this.code = code; }
}

const DEFAULTS = {
  maxBytes: 64 * 1024,        // directory / card byte limit after decoding
  maxKeys: 32,                // key-count limit
  timeoutMs: 3000,            // wall-clock fetch timeout
  positiveTtlMs: 24 * 3600e3, // cap on how long a directory is trusted (Cache-Control may shorten it)
  negativeTtlMs: 5 * 60e3,    // App. C.5: no more than five minutes
  minTtlMs: 60e3,
  insecureAllowHttp: false,   // tests only. Never in production.
  allowPrivateNetwork: false, // tests only.
  // Looked up at call time, not at import: a runtime or test that installs fetch later is honoured.
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  userAgent: "LudionGate/0.0.1 (+https://ludion.ai/gate)",
};

/** Names that only ever mean the local host or network. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet)$/;

/**
 * Reject URLs that must not be fetched, before any connection: scheme, credentials, IP literals
 * that are not public (every form the URL parser normalises to, e.g. 2130706433, 0x7f.1, [::ffff:7f00:1]),
 * and names that are local by construction (single-label names such as `metadata`, `.internal`, …).
 * A name that resolves to a non-public address is caught at connect time by the runtime's fetch
 * (on Node: safe-fetch.mjs, which every Node adapter uses; it checks and pins every resolved address — DNS rebinding).
 */
export function assertFetchable(url, opts) {
  if (url.protocol !== "https:" && !(opts.insecureAllowHttp && url.protocol === "http:")) {
    throw new DiscoveryError(`refusing non-https discovery URL: ${url.protocol}`, "scheme");
  }
  if (url.username || url.password) throw new DiscoveryError("credentials in discovery URL", "url");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (opts.allowPrivateNetwork) return;
  if (isIpLiteral(host)) {
    if (!isPublicAddress(host)) throw new DiscoveryError("refusing non-public IP address", "private");
    return;
  }
  if (!host.includes(".") || LOCAL_NAME.test(host)) throw new DiscoveryError("refusing local hostname", "private");
}

/** Parse max-age from Cache-Control, bounded. */
function ttlFromHeaders(headers, opts) {
  const cc = headers.get("cache-control") || "";
  const m = /max-age=(\d+)/i.exec(cc);
  let ttl = opts.positiveTtlMs;
  if (m) ttl = Math.min(ttl, Number(m[1]) * 1000);
  return Math.max(opts.minTtlMs, ttl);
}

async function boundedFetch(url, opts, accept) {
  assertFetchable(url, opts);
  const ac = new AbortController();
  // The wall clock holds even when a fetch implementation ignores the abort signal (GATE-5).
  let t;
  const expired = new Promise((_, reject) => {
    t = setTimeout(() => { ac.abort(); reject(new DiscoveryError("discovery fetch failed: timeout", "network")); }, opts.timeoutMs);
  });
  expired.catch(() => {});
  try {
    const res = await Promise.race([opts.fetch(url, {
      method: "GET", redirect: "manual", signal: ac.signal,
      headers: { accept, "user-agent": opts.userAgent },
    }), expired]);
    if (res.status !== 200) throw new DiscoveryError(`discovery returned ${res.status}`, "status");
    const len = Number(res.headers.get("content-length") || 0);
    if (len > opts.maxBytes) throw new DiscoveryError("directory too large", "size");
    const buf = new Uint8Array(await Promise.race([res.arrayBuffer(), expired]));
    if (buf.byteLength > opts.maxBytes) throw new DiscoveryError("directory too large", "size");
    let json;
    try { json = JSON.parse(new TextDecoder().decode(buf)); }
    catch { throw new DiscoveryError("directory is not JSON", "format"); }
    return { json, ttlMs: ttlFromHeaders(res.headers, opts) };
  } catch (e) {
    if (e instanceof DiscoveryError) throw e;
    if (e?.code === "ERR_LUDION_NON_PUBLIC_ADDRESS") throw new DiscoveryError(e.message, "private");
    throw new DiscoveryError(`discovery fetch failed: ${e?.name === "AbortError" ? "timeout" : e?.message}`, "network");
  } finally { clearTimeout(t); }
}

function validateJwks(json, opts) {
  if (!json || typeof json !== "object" || !Array.isArray(json.keys)) throw new DiscoveryError("not a JWK Set", "format");
  if (json.keys.length > opts.maxKeys) throw new DiscoveryError("too many keys", "size");
  const keys = [];
  for (const k of json.keys) {
    if (!k || typeof k !== "object" || typeof k.kty !== "string") continue;
    // v0: Ed25519 only (spec §10.4). RSA-PSS keys are ignored, not rejected, so a
    // mixed directory still resolves for the keys we can use.
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
    if (k.use && k.use !== "sig") continue;
    keys.push({ kty: "OKP", crv: "Ed25519", x: k.x, ...(k.nbf ? { nbf: k.nbf } : {}), ...(k.exp ? { exp: k.exp } : {}) });
  }
  return keys;
}

/**
 * Resolve a Signature-Agent entry to the identifier URL and a JWK Set.
 * @param {{ uri: string, type: "directory"|"jwks_uri"|"cimd" }} entry
 */
async function fetchKeySet(entry, opts) {
  if (entry.type === "directory") {
    const u = new URL(entry.uri);
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
      throw new DiscoveryError("directory member must be an origin", "format");
    }
    const target = new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, u.origin);
    const { json, ttlMs } = await boundedFetch(target, opts, "application/http-message-signatures-directory+json");
    return { identifier: target.href, keys: validateJwks(json, opts), ttlMs, card: null };
  }
  if (entry.type === "jwks_uri") {
    const target = new URL(entry.uri);
    const { json, ttlMs } = await boundedFetch(target, opts, "application/json");
    target.hash = ""; target.search = "";
    return { identifier: target.href, keys: validateJwks(json, opts), ttlMs, card: null };
  }
  if (entry.type === "cimd") {
    const target = new URL(entry.uri);
    const { json, ttlMs } = await boundedFetch(target, opts, "application/json");
    let card;
    try { card = parseSignatureAgentCard(json, target.href); }
    catch (e) { throw new DiscoveryError(`invalid signature agent card: ${e?.message}`, "format"); }
    if (card.jwks_uri && card.jwks) throw new DiscoveryError("card has both jwks and jwks_uri", "format");
    let keys, ttl = ttlMs;
    if (card.jwks_uri) {
      const r = await boundedFetch(new URL(card.jwks_uri), opts, "application/json");
      keys = validateJwks(r.json, opts); ttl = Math.min(ttl, r.ttlMs);
    } else if (card.jwks) {
      keys = validateJwks(card.jwks, opts);
    } else throw new DiscoveryError("card has no key material", "format");
    // A Diver's Root key never signs requests (spec §10.3). When the card names its Root
    // (ludion.root_kid), that key is unusable for requests whatever the key set says.
    const rootKid = typeof json?.ludion?.root_kid === "string" ? json.ludion.root_kid : undefined;
    if (rootKid) keys = keys.filter((k) => thumbprint(k) !== rootKid);
    target.hash = ""; target.search = "";
    return { identifier: target.href, keys, ttlMs: ttl, card };
  }
  throw new DiscoveryError(`unsupported discovery type ${entry.type}`, "type");
}

/**
 * Create a resolver for web-bot-auth's verify(). Returns an object with
 * `resolve(candidate)` (throws DiscoveryError when the URL cannot be resolved),
 * plus `prime(identifier, jwks)` for pinned/offline key sets (tests, Ludion Card
 * Host prefetch), and `identifierOf(candidate)`.
 */
export function createResolver(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  /** @type {Map<string, { keys: any[], thumbprints: Map<string, any>, expiresAt: number, card: any }>} */
  const positive = new Map();
  /** @type {Map<string, number>} */
  const negative = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  async function thumbprintIndex(keys) {
    const idx = new Map();
    for (const k of keys) idx.set(thumbprint(k), k);
    return idx;
  }

  async function load(entry) {
    const cacheKey = `${entry.type}:${entry.uri}`;
    const now = opts.now();
    const hit = positive.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit;
    const neg = negative.get(cacheKey);
    if (neg && neg > now) throw new DiscoveryError("negative cache", "negative");
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const p = (async () => {
      try {
        const r = await fetchKeySet(entry, opts);
        const rec = { ...r, thumbprints: await thumbprintIndex(r.keys), expiresAt: now + r.ttlMs };
        positive.set(cacheKey, rec); negative.delete(cacheKey);
        return rec;
      } catch (e) {
        // A failed fetch is not evidence; keep any stale positive entry (draft §6.10).
        negative.set(cacheKey, now + opts.negativeTtlMs);
        if (hit) return hit;
        throw e;
      } finally { inflight.delete(cacheKey); }
    })();
    inflight.set(cacheKey, p);
    return p;
  }

  return {
    /** Resolver hook for verify(). Lookup keyed on (URL, keyid). */
    async resolve(candidate) {
      if (candidate.algorithm !== "ed25519") throw new DiscoveryError("algorithm not accepted in v0", "alg");
      const entry = candidate.signatureAgent;
      if (!entry) throw new DiscoveryError("no signature-agent member covered by the signature", "no-agent");
      const rec = await load(entry);
      const jwk = rec.thumbprints.get(candidate.keyid);
      if (!jwk) throw new DiscoveryError("keyid not published by signature-agent", "unknown-key");
      const t = Math.floor(opts.now() / 1000);
      if (jwk.nbf && t < jwk.nbf) throw new DiscoveryError("key not yet valid", "key-time");
      if (jwk.exp && t > jwk.exp) throw new DiscoveryError("key expired", "key-time");
      // Imported once per key per cached key set (GATE-4): importing is most of the cost of a warm verify.
      rec.verifiers ??= new Map();
      let v = rec.verifiers.get(candidate.keyid);
      if (!v) { v = await verifierFromJWK(jwk); rec.verifiers.set(candidate.keyid, v); } // frozen; wrapped below to attach attribution
      return { algorithm: v.algorithm, keyid: v.keyid, verify: (data, sig) => v.verify(data, sig), identifier: rec.identifier, card: rec.card };
    },
    /** Pin a key set for an identifier without fetching (offline / pinned). */
    async prime(entry, jwks, ttlMs = opts.positiveTtlMs, card = null) {
      const keys = validateJwks(jwks, opts);
      positive.set(`${entry.type}:${entry.uri}`, {
        identifier: entry.uri, keys, thumbprints: await thumbprintIndex(keys), expiresAt: opts.now() + ttlMs, card,
      });
    },
    stats() { return { cached: positive.size, negative: negative.size, inflight: inflight.size }; },
  };
}
