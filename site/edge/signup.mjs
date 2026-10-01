// POST /api/signup: the early-access form's endpoint (WEB-8). A Web-standard Request in, a Response
// out, no dependencies: the Worker (./worker.mjs) runs it on the preview, and any runtime with
// fetch can (site/api/signup.js puts it on Vercel).
// - A person's submission reaches the notifier (SIGNUP_WEBHOOK_URL: a Slack or Discord incoming
//   webhook), and the answer says so only once the notifier took it.
// - A bot's does not. A filled honeypot is answered exactly like a success and dropped; a client
//   over its limit, or everyone over the global one, is answered 429 and dropped. Every POST counts,
//   so a flood of garbage is limited too.
// - Nothing is logged: the email lives only in the notification.
// The limits are kept in memory, per instance (a Workers isolate): they stop a burst, not a
// distributed crawl, which is what the honeypot is for (docs/adr/2026-10-01-signup-endpoint-on-the-site-worker.md).

import { HONEYPOT, LANGS, ROLES } from "./form.mjs";

export { ENDPOINT, HONEYPOT, LANGS, ROLES } from "./form.mjs";
export const LIMITS = { perClient: 5, global: 100, windowMs: 10 * 60_000, clients: 10_000 };
export const MAX_BODY = 4096;
const NOTIFY_TIMEOUT_MS = 5000;

// No "<", ">" or whitespace anywhere, so nothing in it is markup to a chat app.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Sliding-window limits: `perClient` attempts per client and `global` attempts in all, per
 * `windowMs`. At most `clients` clients are remembered; past that the longest-idle is forgotten.
 * @returns {{ take(client: string): number }} 0 when the attempt may go on, else seconds to wait
 */
export function createLimiter({ perClient, global, windowMs, clients } = LIMITS, now = Date.now) {
  const byClient = new Map();
  let all = [];
  const fresh = (list, t) => list.filter((x) => t - x < windowMs);
  const wait = (list, t) => Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
  return {
    take(client) {
      const t = now();
      all = fresh(all, t);
      const mine = fresh(byClient.get(client) ?? [], t);
      byClient.delete(client); // re-inserted last: the Map's order is least recently seen first
      let retry = 0;
      if (mine.length >= perClient) retry = wait(mine, t);
      else if (all.length >= global) retry = wait(all, t);
      else all.push(t); // one client held at its own limit never fills the global one
      mine.push(t); // held attempts count: hammering keeps a client held
      byClient.set(client, mine.slice(-perClient));
      while (byClient.size > clients) byClient.delete(byClient.keys().next().value);
      return retry;
    },
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

/** The form's fields from a JSON or urlencoded body; null when it is neither. */
async function fields(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/x-www-form-urlencoded") return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooLarge: true };
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// Slack reads &, < and > as markup; Discord is told to ping no one.
const plain = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param {Request} request
 * @param {{ webhook?: string, client?: string, limiter: ReturnType<typeof createLimiter>, fetch?: typeof fetch, now?: () => number }} opts
 * @returns {Promise<Response>}
 */
export async function handleSignup(request, { webhook, client = "", limiter, fetch: send = fetch, now = Date.now }) {
  if (request.method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  const retry = limiter.take(client);
  if (retry) return json(429, { error: "rate_limited" }, { "retry-after": String(retry) });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "too_large" });
  const body = await fields(request);
  if (!body) return json(415, { error: "content_type" });
  if (body.tooLarge) return json(413, { error: "too_large" });
  if (String(body[HONEYPOT] ?? "") !== "") return json(200, { ok: true });
  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return json(400, { error: "email" });
  const role = ROLES.includes(body.role) ? body.role : "other";
  const lang = LANGS.includes(body.lang) ? body.lang : "en";
  const site = /^https?:\/\/[^\s<>"]{1,200}$/.test(String(body.site ?? "")) ? String(body.site) : "";
  if (!webhook) return json(503, { error: "unavailable" });
  const record = { ts: new Date(now()).toISOString(), email, role, site, lang };
  const text = plain(`New Ludion signup: ${email} (${[role, site, lang].filter(Boolean).join(", ")})`);
  try {
    const r = await send(webhook, {
      method: "POST", headers: { "content-type": "application/json" },
      // The site field is a URL the person typed: no notifier fetches or previews it (Discord flags 4 =
      // SUPPRESS_EMBEDS; Slack unfurl off), and no one is pinged.
      body: JSON.stringify({ text, content: text, allowed_mentions: { parse: [] }, flags: 4, unfurl_links: false, unfurl_media: false, record }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!r.ok) return json(502, { error: "notify" });
  } catch { return json(502, { error: "notify" }); }
  return json(200, { ok: true });
}
