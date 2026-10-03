// What the pilot keeps about one request: the Gate's metadata event (spec §11.7) for automation,
// plus a few fields that say *why* it was classified so (the agent a User-Agent names, the reason
// a signature failed, the signature's lifetime). Every extra field is a word from a fixed
// vocabulary, a host name or a number; nothing a person typed or sent can reach a row. Humans
// (UNKNOWN) are never kept, with one exception: a request for a path on the probe list (/.env,
// /wp-login.php, …; probes.mjs) is kept whatever its User-Agent says, under the list's own label,
// since scanners often say they are browsers. The rows stay in the site's own D1.
import { metadataEvent, routePath, AUTOMATION } from "@ludion/gate-core";
import { agentName, UNNAMED } from "@ludion/report";
import { probeOf } from "./probes.mjs";

/** Columns of one row, in order (store.mjs writes them, the report reads a subset). */
export const COLUMNS = [
  "rid", "ts", "site", "method", "route", "class", "decision", "error", "pressure", "diver", "country",
  "operator", "token", "reason", "code", "sig_agent", "sig_lifetime", "sig_nonce", "probe", "status",
];

const WORD = /^[A-Za-z0-9_.-]{1,48}$/;
const word = (v) => (typeof v === "string" && WORD.test(v) ? v : null);
const OPERATOR = /^[A-Za-z0-9 .&-]{1,32}$/;

/** The host of the agent's key directory (Signature-Agent, string or dictionary form), or null. */
export function agentHost(value) {
  if (typeof value !== "string") return null;
  const m = /https?:\/\/[^\s"',;<>]+/.exec(value);
  if (!m) return null;
  const name = agentName(m[0]);
  return name === UNNAMED || !name.includes(".") ? null : name;
}

/** created/expires/nonce of the first signature in Signature-Input. Diagnostic only, never trusted. */
export function signatureFacts(input) {
  if (typeof input !== "string" || !input) return { lifetime: null, nonce: null };
  const created = /;\s*created=(\d{1,12})(?=[;,\s]|$)/.exec(input);
  const expires = /;\s*expires=(\d{1,12})(?=[;,\s]|$)/.exec(input);
  const lifetime = created && expires ? Number(expires[1]) - Number(created[1]) : null;
  return { lifetime: Number.isSafeInteger(lifetime) ? lifetime : null, nonce: /;\s*nonce=/.test(input) ? 1 : 0 };
}

/**
 * The row for one inspected request, or null when there is nothing to keep (a human, or a request
 * the Gate could not inspect).
 * @param {{ cls: any, receipt: any }} result   gate.inspect()'s result
 * @param {Request} request
 * @param {{ status?: number|null }} [response]  the status the site answered with
 */
export function eventRow(result, request, { status = null } = {}) {
  const cls = result?.cls, receipt = result?.receipt;
  if (!receipt) return null;
  const probe = probeOf(new URL(request.url).pathname);
  if (!AUTOMATION.has(cls?.class) && !probe) return null;
  const e = metadataEvent({ receipt, path: routePath(request.url), country: request.cf?.country });
  const facts = signatureFacts(request.headers.get("signature-input"));
  return {
    rid: e.rid, ts: e.ts, site: e.site, method: e.method, route: e.route, class: e.class, decision: e.decision,
    error: e.error ?? null, pressure: e.pressure, diver: typeof e.diver === "string" ? e.diver : null, country: e.country,
    operator: cls.class === "DECLARED" && typeof cls.operator === "string" && OPERATOR.test(cls.operator) ? cls.operator : null,
    token: cls.class === "DECLARED" ? word(cls.token) : cls.class === "SUSPECTED" ? word(cls.signal) : null,
    reason: word(cls.reason), code: word(cls.code),
    sig_agent: agentHost(request.headers.get("signature-agent")),
    sig_lifetime: facts.lifetime, sig_nonce: facts.nonce,
    probe, status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  };
}
