// The morning report: yesterday (in the site's time zone) from the rows in D1, through
// @ludion/report, unchanged. Saved in D1 in Japanese and English; if a webhook is set, the
// Japanese one is posted (Discord: the HTML attached; Slack: text only).
import { readEvent, summarize, renderText, renderHtml, subject, dayWindow, addDays, dateIn, fmt, LANGS } from "@ludion/report";
import { store } from "./store.mjs";

const TOP = 5;

function tally(rows, pick) {
  const m = new Map();
  for (const r of rows) { const k = pick(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key, count]) => ({ key, count }));
}

/**
 * What the daily report does not show and the pilot keeps: the operators that User-Agents name
 * (DECLARED), the automation signals (SUSPECTED), who signs (the host of each Signature-Agent,
 * whatever the outcome) and why a signature did not verify.
 * @param {object[]} rows one day's rows
 */
export function extras(rows) {
  return {
    declared: tally(rows, (r) => (r.class === "DECLARED" ? r.operator ?? r.token : null)),
    suspected: tally(rows, (r) => (r.class === "SUSPECTED" ? r.token : null)),
    signers: tally(rows, (r) => r.sig_agent),
    unverified: tally(rows, (r) => (r.sig_lifetime != null && r.class !== "VERIFIED" ? `${r.class} ${r.reason ?? "?"}${r.code ? `/${r.code}` : ""}` : null)),
    long_lived: rows.filter((r) => r.sig_lifetime != null && r.sig_lifetime > 60).length,
  };
}

const list = (items, none) => (items.length ? items.slice(0, TOP).map((i) => `${i.key} ${fmt(i.count)}`).join("、") : none);

/** The message that goes with the attached report (Japanese; the full report is the attachment). */
export function message(summary, x) {
  const c = summary.classes;
  return [
    subject(summary, "ja"),
    `自動化 ${fmt(summary.events)} 件：VERIFIED ${fmt(c.VERIFIED)}・UNVERIFIED ${fmt(c.UNVERIFIED)}・SPOOFED ${fmt(c.SPOOFED)}・REVOKED ${fmt(c.REVOKED)}・DECLARED ${fmt(c.DECLARED)}・SUSPECTED ${fmt(c.SUSPECTED)}`,
    `User-Agent で名乗った運営者：${list(x.declared, "なし")}`,
    `自動化の兆候：${list(x.suspected, "なし")}`,
    `署名してきたエージェント（鍵の置き場所）：${list(x.signers, "なし")}`,
    `検証できなかった署名：${list(x.unverified, "なし")}（うち寿命が 60 秒を超えるもの ${fmt(x.long_lived)} 件）`,
  ].join("\n");
}

/**
 * Post the report. Discord gets the HTML as an attachment; Slack, which takes no files, the text.
 * Nobody is pinged and nothing is previewed. Throws when the webhook does not answer 2xx.
 */
export async function notify(url, { content, html, filename }, { fetch = globalThis.fetch } = {}) {
  let res;
  if (new URL(url).hostname === "hooks.slack.com") {
    const text = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }) });
  } else {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] }, flags: 4 }));
    form.append("files[0]", new Blob([html], { type: "text/html; charset=utf-8" }), filename);
    res = await fetch(url, { method: "POST", body: form });
  }
  if (!res.ok) throw new Error(`report webhook answered ${res.status}`);
}

/**
 * Build, save and post yesterday's report.
 * @param {{ db: D1Database, site: string, tz: string, now: number, webhook?: string, retainDays?: number, fetch?: typeof fetch }} o
 */
export async function daily({ db, site, tz, now, webhook, retainDays, fetch = globalThis.fetch }) {
  const date = addDays(dateIn(tz, now), -1);
  const win = dayWindow(date, tz), prev = dayWindow(addDays(date, -1), tz);
  const st = store(db);
  const rows = await st.events(Math.floor(prev.start / 1000), Math.ceil(win.end / 1000));
  const summary = summarize(rows.map(readEvent).filter(Boolean), { site, date, tz });
  const x = extras(rows.filter((r) => r.site === site && r.ts * 1000 >= win.start && r.ts * 1000 < win.end));
  const out = {};
  for (const lang of LANGS) {
    out[lang] = { subject: subject(summary, lang), text: renderText(summary, lang), html: renderHtml(summary, lang) };
    await st.saveReport({ site, date, lang, ...out[lang], summary: { ...summary, pilot: x }, created: Math.floor(now / 1000) });
  }
  const problems = [];
  if (webhook) {
    try { await notify(webhook, { content: message(summary, x), html: out.ja.html, filename: `ludion-${site}-${date}.html` }, { fetch }); }
    catch (e) { problems.push(String(e?.message ?? e)); }
  }
  if (retainDays > 0) {
    try { await st.prune(Math.floor(now / 1000) - retainDays * 86400); }
    catch (e) { problems.push(`prune: ${e?.message ?? e}`); }
  }
  return { date, summary, extras: x, problems };
}
