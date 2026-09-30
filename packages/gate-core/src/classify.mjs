// Classification and decision (spec §10.8, §11.3, §11.5).
//
// Outcomes follow draft-ietf-webbotauth-httpsig-protocol-00 App. C.1, which
// keeps verified / invalid / unverified distinct:
//   VERIFIED   signature valid against keys resolved from the Signature-Agent URL
//   UNVERIFIED signature present, but discovery failed or keyid unknown → not attributable
//   SPOOFED    signature present and cryptographically invalid, or Staple invalid
//   REVOKED    signature valid, Staple says revoked/suspended
//   DECLARED   no signature, User-Agent matches a published agent token
//   SUSPECTED  no signature, weak automation signal
//   UNKNOWN    everything else, including humans
//
// Gate never changes the human path (spec §10.8): decisions only ever apply to
// requests classified as automation, and a rejection always carries a help link.

import { verify } from "web-bot-auth";
import { isSignatureError } from "http-message-sig";
import { DiscoveryError } from "./resolver.mjs";
import { StapleError } from "./staple.mjs";
import { verifyMandate, MandateError } from "./mandate.mjs";
import { matchKnownAgent, matchAutomationSignal } from "./agents.mjs";
import { GateFault, within, clock } from "./budget.mjs";
import { routeCandidates } from "./route.mjs";
import { requestAuthority } from "./authority.mjs";

export const CLASSES = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED", "UNKNOWN"];
export const AUTOMATION = new Set(["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED"]);

const MAX_SIG_AGE_S = 60;       // spec §10.4: expires - created ≤ 60s
const CLOCK_SKEW_S = 30;        // spec §10.4: ±30s
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Bounded in-memory replay cache (spec §11.6: a nonce is held for the signature's validity).
 * An entry still inside its validity is never evicted: evicting it would let anyone with a valid
 * key of their own flood the cache and then replay someone else's captured request. Memory stays
 * bounded instead by refusing to record: once half full, an owner (the signer's identifier)
 * already holding `perOwnerMax` live entries is refused ("quota"), so a flooder is stopped before
 * others are; when full of live entries, everyone new is refused ("full"). A refused signature
 * cannot be shown not to be a replay, so it is not attributable (UNVERIFIED), never VERIFIED.
 */
export function createNonceCache({ maxEntries = 100_000, perOwnerMax, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 2) throw new TypeError("nonceCache.maxEntries must be an integer ≥ 2");
  const ownerMax = perOwnerMax ?? Math.max(1, Math.floor(maxEntries / 4));
  const seen = new Map(); // key -> { exp, owner }, in insertion order
  const owners = new Map(); // owner -> live entries
  let calls = 0, lastFullSweep = -Infinity;
  const drop = (k, e) => {
    seen.delete(k);
    const n = (owners.get(e.owner) ?? 1) - 1;
    if (n > 0) owners.set(e.owner, n); else owners.delete(e.owner);
  };
  const sweep = (t, all) => { for (const [k, e] of seen) { if (e.exp <= t) drop(k, e); else if (!all) break; } };
  function record(key, expiresAtMs, owner = "") {
    const t = now();
    if (++calls % 1000 === 0) sweep(t, true);
    const prev = seen.get(key);
    if (prev) { if (prev.exp > t) return "replay"; drop(key, prev); }
    if (seen.size >= maxEntries) {
      sweep(t, false); // the oldest entries usually expire first
      if (seen.size >= maxEntries && t - lastFullSweep >= 1000) { lastFullSweep = t; sweep(t, true); } // at most once a second under load
      if (seen.size >= maxEntries) return "full";
    }
    if (seen.size * 2 >= maxEntries && (owners.get(owner) ?? 0) >= ownerMax) return "quota";
    seen.set(key, { exp: expiresAtMs, owner });
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    return "fresh";
  }
  return {
    record,
    /** @returns {boolean} true if fresh (and now recorded) */
    check(key, expiresAtMs, owner) { return record(key, expiresAtMs, owner) === "fresh"; },
    size() { return seen.size; },
  };
}

function field(req, name) {
  const v = req.fields.filter((f) => f.name.toLowerCase() === name).map((f) => f.value);
  return v.length ? v.join(", ") : undefined;
}

// Fields that claim a Web Bot Auth identity or Ludion standing. A lone legacy `Signature`
// (e.g. draft-cavage signatures between fediverse servers) is not one of them.
const CLAIM_FIELDS = ["signature-input", "signature-agent", "ludion-staple", "ludion-mandate"];

/** The request announces a body (the Gate never reads it; spec §11.7). */
function announcesBody(req) {
  return Number(field(req, "content-length") ?? 0) > 0 || field(req, "transfer-encoding") !== undefined;
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

/**
 * Key discovery for one signature, bounded by the Gate's discovery deadline. Whatever goes wrong
 * here (the directory, the network, the resolver itself, the budget) is a discovery failure and
 * so UNVERIFIED (spec §10.8), never a Gate fault: the requester chose the Signature-Agent, and a
 * discovery outcome that could fail open would let a tarpit bypass Pressure 2 (ADR-020).
 */
async function discover(ctx, candidate) {
  const pending = Promise.resolve().then(() => ctx.resolver.resolve(candidate));
  const v = ctx.discoveryDeadline === undefined ? await pending
    : await within(pending, ctx.discoveryDeadline - clock(), () => new DiscoveryError("key discovery exceeded the Gate's time budget", "timeout"));
  if (!v || typeof v !== "object" || typeof v.verify !== "function" || typeof v.algorithm !== "string") {
    throw new DiscoveryError("resolver returned no usable verifier", "resolver");
  }
  const check = v.verify;
  return { ...v, verify: async (data, signature) => (await check.call(v, data, signature)) === true }; // only a real `true` verifies
}

/**
 * Classify one request. Throws only on a fault inside the Gate (clock, bug); everything the
 * request can influence becomes a class.
 * @param {import("http-message-sig").RequestDescriptor} req
 * @param {{ resolver: ReturnType<import("./resolver.mjs").createResolver>,
 *           stapleVerifier?: Awaited<ReturnType<import("./staple.mjs").createStapleVerifier>>,
 *           nonceCache?: ReturnType<typeof createNonceCache>, now?: () => number,
 *           requireNonce?: boolean, discoveryDeadline?: number, categories?: string[],
 *           authorities?: ReturnType<import("./authority.mjs").createAuthorities>,
 *           revocations?: ReturnType<import("./revocation.mjs").createRevocationList> }} ctx
 */
export async function classify(req, ctx) {
  const ua = field(req, "user-agent");
  const hasSig = !!field(req, "signature-input") && !!field(req, "signature");
  const method = req.method.toUpperCase();

  if (!hasSig) {
    // Stripping (part of) a signature must not turn a claimed agent into "just a visitor":
    // naming an agent or standing without a complete signature is a spoof (spec §11.5).
    const claims = CLAIM_FIELDS.filter((n) => field(req, n) !== undefined);
    if (claims.length) return { class: "SPOOFED", reason: "unsigned_claim", detail: `${claims.join(", ")} without a complete signature`, signatureAgent: field(req, "signature-agent") };
    const known = matchKnownAgent(ua);
    if (known) return { class: "DECLARED", operator: known.operator, token: known.token, kind: known.kind };
    const signal = matchAutomationSignal(ua);
    if (signal) return { class: "SUSPECTED", signal };
    return { class: "UNKNOWN" };
  }

  // A signature is only for the authority it covers. When the site has said which authorities
  // are its own, one made for any other site is refused before discovery (no fetch, no crypto):
  // it was captured elsewhere and replayed here with that site's Host (ADR-023).
  const authority = requestAuthority(req.targetUri);
  const pinned = !!ctx.authorities?.pinned;
  if (pinned && !ctx.authorities.allows(authority)) {
    return { class: "SPOOFED", reason: "foreign_authority", detail: "signed for an authority that is not one of this site's", signatureAgent: field(req, "signature-agent") };
  }

  // The clock is the Gate's own: if it fails, that is a Gate fault (fail_mode), not a bad signature.
  let now;
  if (ctx.now) {
    const t = ctx.now();
    if (!Number.isFinite(t)) throw new GateFault("clock returned a non-finite time", "clock");
    now = new Date(t);
  }

  let sig;
  try {
    sig = await verify(req, {
      resolver: (c) => discover(ctx, c),
      algorithms: ["ed25519"],
      maxAge: MAX_SIG_AGE_S + CLOCK_SKEW_S,
      clockSkew: CLOCK_SKEW_S,
      now,
      validate: (s) => {
        if (s.expires.getTime() - s.created.getTime() > MAX_SIG_AGE_S * 1000) return false; // spec §10.4
        if (ctx.requireNonce && !s.nonce) return false;
        const names = s.components.map((c) => (typeof c === "string" ? c : c.name));
        // A Staple/Mandate that is present MUST be covered (spec §10.1); otherwise it can be swapped.
        if (field(req, "ludion-staple") && !names.includes("ludion-staple")) return false;
        if (field(req, "ludion-mandate") && !names.includes("ludion-mandate")) return false;
        // State-changing requests must bind method, path and body (spec §10.4).
        if (STATE_CHANGING.has(method) && !(names.includes("@method") && names.includes("@path"))) return false;
        if (STATE_CHANGING.has(method) && field(req, "content-digest") && !names.includes("content-digest")) return false;
        if (STATE_CHANGING.has(method) && announcesBody(req) && !names.includes("content-digest")) return false; // body unbound
        return true;
      },
    });
  } catch (e) {
    // http-message-sig wraps resolver failures as SignatureError{code:"ResolverFailed", cause}.
    const cause = e?.code === "ResolverFailed" ? e.cause : null;
    if (cause instanceof DiscoveryError) {
      return { class: "UNVERIFIED", reason: cause.code, detail: cause.message, signatureAgent: field(req, "signature-agent") };
    }
    // web-bot-auth runs its profile checks (tag, bare @authority, exactly one covered
    // Signature-Agent member, nonce shape) inside the resolver hook, so they arrive wrapped as
    // ResolverFailed. They are invalid signatures, not discovery failures (spec §10.8).
    if (isSignatureError(cause)) {
      return { class: "SPOOFED", reason: "invalid_signature", code: cause.code, detail: cause.message, signatureAgent: field(req, "signature-agent") };
    }
    if (e?.code === "ResolverFailed") {
      return { class: "UNVERIFIED", reason: "resolver", detail: String(cause?.message ?? e.message), signatureAgent: field(req, "signature-agent") };
    }
    return { class: "SPOOFED", reason: "invalid_signature", code: e?.code, detail: e?.message, signatureAgent: field(req, "signature-agent") };
  }

  // Replay (spec §10.4). A signature stays acceptable until expires + skew, so it is remembered
  // that long. Without a nonce, the same signature on the same method and target is the replay;
  // the same signature on another path is what a signer that binds no nonce and no @path chose.
  if (ctx.nonceCache) {
    const key = sig.nonce ? `n ${sig.keyid} ${sig.nonce}` : `s ${method} ${req.targetUri} ${b64(sig.signature)}`;
    const exp = sig.expires.getTime() + CLOCK_SKEW_S * 1000;
    const seen = ctx.nonceCache.record ? ctx.nonceCache.record(key, exp, sig.verifier.identifier) : (ctx.nonceCache.check(key, exp) ? "fresh" : "replay");
    if (seen === "replay") return { class: "SPOOFED", reason: "replay", identifier: sig.verifier.identifier };
    if (seen !== "fresh") {
      // Not recorded, so not provably fresh: not attributable (the flooder hits "quota" first).
      return { class: "UNVERIFIED", reason: seen === "quota" ? "replay_quota" : "replay_cache_full", signatureAgent: field(req, "signature-agent") };
    }
  }

  const out = {
    class: "VERIFIED",
    identifier: sig.verifier.identifier, // the resolved URL, not the header value (draft §4.1)
    keyid: sig.keyid,
    label: sig.label,
    card: sig.verifier.card ?? null,
    depth: 0, ballast: { status: "none" }, staple: null,
    covered: sig.components.map((c) => (typeof c === "string" ? c : c.name)),
    authorityPinned: pinned,
  };

  // Revocation (spec §10.10): the signing key or the Signature-Agent is on the Registry's list the
  // Gate holds. Read from memory only; the Registry is never asked about a request (PRIV-3).
  const revokedKey = ctx.revocations?.match({ jkt: sig.keyid, identifier: out.identifier });
  if (revokedKey) return { ...out, class: "REVOKED", revocation: revokedKey };

  const stapleHdr = field(req, "ludion-staple");
  if (stapleHdr) {
    if (!ctx.stapleVerifier) { out.stapleError = "no_registry_keys"; return out; }
    try {
      const st = await ctx.stapleVerifier.verify(stapleHdr, { requestKeyid: sig.keyid });
      out.staple = st; out.diverId = st.sub; out.depth = st.depth; out.ballast = st.ballast ?? { status: "none" };
      if (st.revoked === true) return { ...out, class: "REVOKED", revocation: { sub: st.sub, reason: "staple" } };
      const revokedDiver = ctx.revocations?.match({ sub: st.sub });
      if (revokedDiver) return { ...out, class: "REVOKED", revocation: revokedDiver };
    } catch (e) {
      if (e instanceof StapleError && e.code === "expired") return { ...out, stapleError: "staple_expired" };
      return { ...out, class: "SPOOFED", reason: "invalid_staple", detail: e?.message };
    }
  }

  // Mandate (spec §10.6). Carrying a delegation that was never given (forged, or another Diver's)
  // is a spoof; a real one that does not hold here and now (another site, expired, withdrawn, no
  // Staple to say whose it is) is simply no Mandate: decide() then answers mandate_required.
  const mandateHdr = field(req, "ludion-mandate");
  if (mandateHdr) {
    if (!ctx.stapleVerifier) { out.mandateError = "no_registry_keys"; return out; }
    try {
      out.mandate = await verifyMandate(mandateHdr, {
        stapleVerifier: ctx.stapleVerifier, staple: out.staple, authority, authorities: ctx.authorities,
        categories: ctx.categories, revocations: ctx.revocations, now: now ? now.getTime() : Date.now(), skewS: CLOCK_SKEW_S,
      });
    } catch (e) {
      if (!(e instanceof MandateError)) throw e; // not the request's doing: a Gate fault
      // A spoof keeps nothing the Staple granted: no Diver, no Depth, no Ballast (GATE-7 mandate-swap).
      if (e.code === "invalid" || e.code === "subject") {
        return { ...out, class: "SPOOFED", reason: "invalid_mandate", detail: e.message, staple: null, diverId: undefined, depth: 0, ballast: { status: "none" } };
      }
      out.mandateError = e.code;
    }
  }
  return out;
}

// ---- Routes & Pressure -----------------------------------------------------

/**
 * Minimal glob → RegExp: `**` any depth, `*` one segment, `:id` param. Matched the way common
 * frameworks route (Express: case-insensitive, non-strict): any case, an optional trailing
 * slash, and a trailing `/**` also covers the base path (`/checkout/**` protects POST /checkout).
 */
export function compileRoute(pattern) {
  let p = String(pattern);
  const deep = p.endsWith("/**");
  if (deep) p = p.slice(0, -3);
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/:(\w+)/g, "[^/]+");
  return new RegExp(`^${re}${deep ? "(?:/.*)?" : "/?"}$`, "i");
}

/**
 * @param {{ pressure?: number, routes?: {match:string, pressure?:number, require?:{depth?:number, scope?:string, ballast?:"active"}}[] }} config
 */
export function createPolicy(config = {}) {
  const routes = (config.routes ?? []).map((r) => ({ ...r, re: compileRoute(r.match) }));
  const base = Number.isInteger(config.pressure) ? config.pressure : 0;
  return {
    /**
     * The route protecting a request path. Every path the app could plausibly route the request
     * to is tried (routeCandidates); each takes its first matching route, and the highest
     * pressure wins (ties: the literal path first). Erring toward protection only ever affects
     * automation: decide() never touches UNKNOWN.
     * @param {string} path
     */
    forPath(path) {
      let best;
      for (const c of routeCandidates(path)) {
        const r = routes.find((x) => x.re.test(c));
        const pressure = r?.pressure ?? base;
        if (!best || pressure > best.pressure) best = { r, pressure };
      }
      return { pressure: best.pressure, require: best.r?.require ?? null, template: best.r?.match ?? null };
    },
  };
}

/**
 * Decide what to do. Never touches UNKNOWN (humans). Returns {action, status?, error?}.
 * action: "allow" | "friction" | "deny"
 */
export function decide(cls, route) {
  const p = route.pressure;
  if (!AUTOMATION.has(cls.class)) return { action: "allow" };
  if (p <= 0) return { action: "allow" };
  if (p === 1) {
    if (cls.class === "VERIFIED") return { action: "allow", exempt: true };
    return { action: "friction" }; // site's existing friction (captcha etc.), never a hard block
  }
  // p >= 2: this route requires conditions for automation
  const req = route.require ?? {};
  if (cls.class === "REVOKED") return { action: "deny", status: 403, error: "revoked" };
  if (cls.class === "SPOOFED") return { action: "deny", status: 401, error: "invalid_signature" };
  if (cls.class !== "VERIFIED") {
    if (p === 2 && cls.class === "UNKNOWN") return { action: "allow" };
    return { action: "deny", status: 401, error: cls.stapleError === "staple_expired" ? "staple_expired" : "signature_required" };
  }
  if (cls.stapleError === "staple_expired") return { action: "deny", status: 401, error: "staple_expired" };
  if (req.depth !== undefined && (cls.depth ?? 0) < req.depth) return { action: "deny", status: 403, error: "depth_insufficient" };
  if (req.ballast === "active" && cls.ballast?.status !== "active") return { action: "deny", status: 403, error: "ballast_required" };
  if (req.scope) {
    const m = cls.mandate;
    if (!m) return { action: "deny", status: 403, error: "mandate_required" };
    if (!m.scope?.includes(req.scope)) return { action: "deny", status: 403, error: "mandate_scope" };
  }
  return { action: "allow", exempt: true };
}

export const ERROR_HELP = (code) => `<https://ludion.ai/e/${code}>; rel="help"`;

/** Every `Ludion-Error` decide() can return, with its HTTP status (spec §10.11). Each has a help page (WEB-3). */
export const ERRORS = Object.freeze({
  signature_required: 401, invalid_signature: 401, staple_expired: 401,
  revoked: 403, depth_insufficient: 403, ballast_required: 403, mandate_required: 403, mandate_scope: 403,
});
