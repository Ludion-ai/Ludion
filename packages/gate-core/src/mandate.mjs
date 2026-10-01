// Mandate (spec §10.6): a Principal's delegation to one Diver — who for, where, what, how much,
// until when — issued by the Registry after the Principal's passkey consent, carried by the agent
// in the `Ludion-Mandate` header (covered by the request signature, spec §10.4).
//
//   { iss, sub: "dvr-…", prn: "pw-…", aud: "https://shop.example" | "cat:ecommerce",
//     scope: ["read", "checkout"], limits: { checkout_max: 50000, currency: "JPY", per_day: 3 },
//     iat, exp, jti: "mdt-…" }
//
// The Gate checks it against what it already holds: the pinned Registry keys (signature, typ,
// issuer), the Staple (the Diver it names, which the request key is bound to), its own
// authorities (the site it names), its clock, and the revocation list. The Registry is never
// asked (REG-1, PRIV-3). Limits are the site's to apply at the moment it knows the amount
// (gate.charge), on the routes it holds to a Mandate; this module keeps the count.
//
// Runtime-neutral, no primitives (CRY-1): signatures go through the Staple verifier.

import { StapleError } from "./staple.mjs";

export const MANDATE_TYP = "ludion-mandate+jwt";
/** spec §10.6: the v0 scope vocabulary. */
export const SCOPES = Object.freeze(["read", "account", "post", "reserve", "checkout", "delete"]);
/** spec §10.6 "寿命は短く、長期はリフレッシュで": default 24 h, never more than 7 days. */
export const DEFAULT_MANDATE_LIFETIME_S = 86_400;
export const MAX_MANDATE_LIFETIME_S = 7 * 86_400;
/** per_day counts charges in any rolling 24 hours. */
export const DAY_MS = 86_400_000;
/** The scope a charge needs. */
export const CHARGE_SCOPE = "checkout";

const CATEGORY = /^cat:[a-z0-9-]{1,32}$/;

export class MandateError extends Error {
  /**
   * @param {string} message
   * @param {"invalid"|"subject"|"no_staple"|"audience"|"expired"|"revoked"} code
   *   invalid, subject: the request carries a delegation it was not given (SPOOFED);
   *   the rest: a real Mandate that does not hold here and now (no Mandate).
   */
  constructor(message, code) { super(message); this.name = "MandateError"; this.code = code; }
}

/** The host a Mandate's `aud` names ("https://shop.example" → "shop.example"), or null. */
export function audienceHost(aud) {
  if (typeof aud !== "string" || !aud.startsWith("https://")) return null;
  try {
    const u = new URL(aud);
    return u.origin === aud ? u.host : null;
  } catch { return null; }
}

/**
 * Verify the Mandate a request carries.
 * @param {string} compact  the Ludion-Mandate header
 * @param {{ stapleVerifier: { verifyStatement: Function }, staple: object|null, authority: string|null,
 *           categories?: string[], revocations?: { match: Function }, now: number, skewS?: number }} ctx
 *   staple: the verified Staple of this request (null if none); authority: the request's
 *   (requestAuthority; a pinned Gate has already refused one that is not its own).
 * @returns {Promise<object>} the payload
 */
export async function verifyMandate(compact, ctx) {
  let p;
  try { p = await ctx.stapleVerifier.verifyStatement(compact, { typ: MANDATE_TYP }); }
  catch (e) { throw new MandateError(`mandate not signed by the Registry: ${e instanceof StapleError ? e.message : "malformed"}`, "invalid"); }
  const skew = ctx.skewS ?? 30;
  const t = Math.floor(ctx.now / 1000);
  if (typeof p.sub !== "string" || !/^dvr-[a-z2-7]{16}$/.test(p.sub)) throw new MandateError("bad mandate subject", "invalid");
  if (typeof p.jti !== "string" || !/^mdt-[A-Za-z0-9_-]{8,64}$/.test(p.jti)) throw new MandateError("bad mandate id", "invalid");
  if (typeof p.prn !== "string" || !p.prn.startsWith("pw-")) throw new MandateError("bad principal pseudonym", "invalid");
  if (!Array.isArray(p.scope) || !p.scope.every((s) => typeof s === "string")) throw new MandateError("bad mandate scope", "invalid");
  if (p.limits != null && (typeof p.limits !== "object" || Array.isArray(p.limits))) throw new MandateError("bad mandate limits", "invalid");
  if (p.scope.includes(CHARGE_SCOPE) && !validLimits(p.limits)) throw new MandateError("a checkout mandate without limits", "invalid");
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat) throw new MandateError("mandate missing iat/exp", "invalid");
  if (p.exp - p.iat > MAX_MANDATE_LIFETIME_S) throw new MandateError("mandate lifetime too long", "invalid");
  if (p.iat > t + skew) throw new MandateError("mandate from the future", "invalid");

  // Whose delegation: the Diver the Staple names, and the Staple is bound to the request key.
  if (!ctx.staple) throw new MandateError("a mandate is attributed through the Staple, and there is none", "no_staple");
  if (p.sub !== ctx.staple.sub) throw new MandateError("mandate delegated to another Diver", "subject");

  // Where: the site this request is for (its authority, which a pinned Gate has already held to its
  // own), or a category the site declares. Not any other authority the same Gate holds: a Mandate
  // for shop.example says nothing about admin.example behind the same Gate.
  const host = audienceHost(p.aud);
  const here = host != null
    ? ctx.authority != null && host === String(ctx.authority).toLowerCase()
    : typeof p.aud === "string" && CATEGORY.test(p.aud) && (ctx.categories ?? []).includes(p.aud.slice(4));
  if (!here) throw new MandateError("mandate is for another site", "audience");

  if (p.exp < t - skew) throw new MandateError("mandate expired", "expired");
  const revoked = ctx.revocations?.match({ mandate: p.jti }) ?? (Array.isArray(ctx.staple.mrev) && ctx.staple.mrev.includes(p.jti) ? { reason: "staple" } : undefined);
  if (revoked) throw new MandateError("mandate revoked by its Principal", "revoked");
  return p;
}

/** A checkout mandate carries a per-charge maximum in a currency; per_day is optional. */
export function validLimits(l) {
  return !!l && typeof l === "object" && Number.isSafeInteger(l.checkout_max) && l.checkout_max > 0
    && typeof l.currency === "string" && /^[A-Z]{3}$/.test(l.currency)
    && (l.per_day == null || (Number.isInteger(l.per_day) && l.per_day > 0));
}

/**
 * What each Mandate has spent at this Gate: charges in the last 24 h, per jti. In memory and per
 * process, like the nonce cache: Gates on several instances each keep their own count. Bounded
 * like the nonce cache too: a count still inside its 24 h is never dropped (dropping it would
 * restart a per_day limit); when `maxMandates` live counts are held, a new Mandate's charge is
 * refused ("ledger_full") rather than let through uncounted.
 * @param {{ now?: () => number, maxMandates?: number }} [o]
 */
export function createMandateLedger({ now = () => Date.now(), maxMandates = 100_000 } = {}) {
  const spent = new Map(); // jti -> charge times (ms), oldest first; least recently charged first
  const sweep = (t) => { for (const [k, times] of spent) if (times[times.length - 1] <= t - DAY_MS) spent.delete(k); };
  return {
    /**
     * Apply the Mandate's limits to one charge and, if it holds, count it.
     * Amounts are integers in the currency's minor unit (JPY: yen; USD: cents), as the limits are.
     * @param {object} m verified Mandate payload @param {{ amount: number, currency: string }} c
     * @returns {{ ok: true, remaining: { per_day: number|null } } | { ok: false, reason: string }}
     */
    charge(m, { amount, currency } = {}) {
      if (!m.scope.includes(CHARGE_SCOPE)) return { ok: false, reason: "scope" };
      const l = m.limits;
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: "bad_amount" };
      if (currency !== l.currency) return { ok: false, reason: "currency" };
      if (amount > l.checkout_max) return { ok: false, reason: "over_limit" };
      const t = now();
      const known = spent.has(m.jti);
      const times = (spent.get(m.jti) ?? []).filter((x) => x > t - DAY_MS);
      if (l.per_day != null && times.length >= l.per_day) return { ok: false, reason: "per_day" };
      if (!known && spent.size >= maxMandates) {
        sweep(t);
        if (spent.size >= maxMandates) return { ok: false, reason: "ledger_full" };
      }
      times.push(t);
      spent.delete(m.jti); spent.set(m.jti, times);
      return { ok: true, remaining: { per_day: l.per_day == null ? null : l.per_day - times.length } };
    },
    size() { return spent.size; },
  };
}
