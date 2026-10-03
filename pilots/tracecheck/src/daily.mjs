// The morning report: yesterday (in the site's time zone) from the rows in D1, through
// @ludion/report, unchanged. Saved in D1 in Japanese and English; if a webhook is set, the
// Japanese one is posted (Discord: the HTML attached; Slack: text only). The pilot adds one section
// the report does not have: automation hunting for secrets and admin pages (probes.mjs).
import { readEvent, summarize, renderText, renderHtml, subject, dayWindow, addDays, dateIn, fmt, LANGS } from "@ludion/report";
import { store } from "./store.mjs";
import { probeKind, KINDS } from "./probes.mjs";

const TOP = 5, TOP_PROBES = 10;

function tally(rows, pick) {
  const m = new Map();
  for (const r of rows) { const k = pick(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key, count]) => ({ key, count }));
}

/** Requests for paths on the probe list: how many, of which kind, which paths, and any the site answered with 2xx. */
export function probeStats(rows) {
  const hits = rows.filter((r) => r.probe);
  const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const r of hits) { const k = probeKind(r.probe); if (k) kinds[k]++; }
  return {
    requests: hits.length, kinds,
    as_browser: hits.filter((r) => r.class === "UNKNOWN").length,
    paths: tally(hits, (r) => r.probe),
    answered_2xx: tally(hits, (r) => (r.status >= 200 && r.status < 300 ? r.probe : null)),
  };
}

/**
 * What the daily report does not show and the pilot keeps: the operators that User-Agents name
 * (DECLARED), the automation signals (SUSPECTED), who signs (the host of each Signature-Agent,
 * whatever the outcome), why a signature did not verify, and the hunt for secrets and admin pages.
 * @param {object[]} rows one day's rows
 */
export function extras(rows) {
  return {
    declared: tally(rows, (r) => (r.class === "DECLARED" ? r.operator ?? r.token : null)),
    suspected: tally(rows, (r) => (r.class === "SUSPECTED" ? r.token : null)),
    signers: tally(rows, (r) => r.sig_agent),
    unverified: tally(rows, (r) => (r.sig_lifetime != null && r.class !== "VERIFIED" ? `${r.class} ${r.reason ?? "?"}${r.code ? `/${r.code}` : ""}` : null)),
    long_lived: rows.filter((r) => r.sig_lifetime != null && r.sig_lifetime > 60).length,
    probes: probeStats(rows),
  };
}

const list = (items, none, n = TOP) => (items.length ? items.slice(0, n).map((i) => `${i.key} ${fmt(i.count)}`).join("、") : none);

const PROBE_TEXT = {
  ja: {
    title: "秘密や管理画面を探しに来た自動化",
    lead: "/.env、/.git、/wp-login.php など、決まった一覧にあるパスへの要求です。ブラウザを名乗るものも多いので、User-Agent に関わらず数えます。パスは一覧の名前でだけ表示します。",
    total: "要求", browser: "うちブラウザを名乗ったもの", head: ["パス", "要求"], none: "ありませんでした。",
    ok2xx: "成功（2xx）で応答したもの", warn: "中身が外に出ていないか確かめてください。", sep: "、",
    kind: { secret: "秘密", admin: "管理画面", exploit: "脆弱性の探索" },
  },
  en: {
    title: "Automation hunting for secrets and admin pages",
    lead: "Requests for paths on a fixed list, such as /.env, /.git and /wp-login.php. Many claim to be browsers, so they are counted whatever their User-Agent says. Paths are shown only as the list names them.",
    total: "requests", browser: "of them claiming to be a browser", head: ["path", "requests"], none: "None.",
    ok2xx: "answered with success (2xx)", warn: "Check that nothing was exposed.", sep: ", ",
    kind: { secret: "secrets", admin: "admin pages", exploit: "known exploits" },
  },
};

/** The hunt for secrets and admin pages as plain text (the message, and the saved text report). */
export function probeLines(p, lang = "ja") {
  const L = PROBE_TEXT[lang];
  const items = (xs) => xs.slice(0, TOP_PROBES).map((i) => `${i.key} ${fmt(i.count)}`).join(L.sep);
  const ja = lang === "ja";
  const [colon, open, semi, close, count] = ja ? ["：", "（", "。", "）", " 件"] : [": ", " (", "; ", ")", ""];
  if (!p.requests) return [`${L.title}${colon}${L.none}`];
  return [
    `${L.title}${colon}${fmt(p.requests)}${count}${open}${KINDS.map((k) => `${L.kind[k]} ${fmt(p.kinds[k])}`).join(L.sep)}${semi}${L.browser} ${fmt(p.as_browser)}${count}${close}`,
    `  ${L.head[0]}${colon}${items(p.paths)}`,
    p.answered_2xx.length ? `  ⚠ ${L.ok2xx}${colon}${items(p.answered_2xx)}${ja ? "。" : ". "}${L.warn}` : `  ${L.ok2xx}${colon}${ja ? "なし" : "none"}`,
  ];
}

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
    ...probeLines(x.probes, "ja"),
  ].join("\n");
}

const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The report's HTML with the pilot's section added before the footer. The report's own sections
 * are untouched; the style follows theirs (email-safe tables, inline styles).
 */
export function withProbes(html, p, lang) {
  const L = PROBE_TEXT[lang];
  const at = html.lastIndexOf('<tr><td style="padding:16px 24px 24px 24px;');
  if (at < 0) return html;
  const cell = "padding:6px 8px;border-top:1px solid #e7e5e4;";
  const row = (a, b, { strong = false, code = false } = {}) => `<tr><td style="${cell}text-align:left;${code ? "font-family:Menlo,Consolas,monospace;font-size:13px;word-break:break-all;" : ""}">${esc(a)}</td>`
    + `<td style="${cell}text-align:right;font-weight:${strong ? 700 : 600};white-space:nowrap;">${esc(b)}</td></tr>`;
  const table = (margin, rows) => [`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;${margin}">`, ...rows, "</table>"];
  const parts = [
    '<tr><td data-section="probes" style="padding:16px 24px 8px 24px;">',
    `<div style="font-size:16px;font-weight:700;margin:0 0 4px 0;">${esc(L.title)}</div>`,
    `<div style="color:#57534e;margin:0 0 8px 0;">${esc(L.lead)}</div>`,
  ];
  if (!p.requests) parts.push(`<div style="color:#57534e;">${esc(L.none)}</div>`);
  else {
    parts.push(...table("", [row(L.total, fmt(p.requests), { strong: true }), ...KINDS.map((k) => row(L.kind[k], fmt(p.kinds[k]))), row(L.browser, fmt(p.as_browser))]));
    parts.push(...table("margin-top:8px;", [
      `<tr>${L.head.map((h, i) => `<th style="padding:6px 8px;text-align:${i ? "right" : "left"};color:#57534e;font-weight:600;">${esc(h)}</th>`).join("")}</tr>`,
      ...p.paths.slice(0, TOP_PROBES).map((i) => row(i.key, fmt(i.count), { code: true })),
    ]));
    if (p.answered_2xx.length) {
      parts.push(`<div data-probe="2xx" style="margin-top:8px;color:#b91c1c;font-weight:700;">${esc(L.ok2xx)}: ${esc(p.answered_2xx.map((i) => `${i.key} ${fmt(i.count)}`).join(L.sep))}. ${esc(L.warn)}</div>`);
    }
  }
  parts.push("</td></tr>");
  return `${html.slice(0, at)}${parts.join("\n")}\n${html.slice(at)}`;
}

/** The report's text with the pilot's section added before the footer line ("—"). */
export function withProbesText(text, p, lang) {
  const at = text.lastIndexOf("\n—\n");
  const block = `■ ${probeLines(p, lang).join("\n")}\n`;
  return at < 0 ? `${text}\n${block}` : `${text.slice(0, at + 1)}${block}${text.slice(at + 1)}`;
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
    out[lang] = {
      subject: subject(summary, lang),
      text: withProbesText(renderText(summary, lang), x.probes, lang),
      html: withProbes(renderHtml(summary, lang), x.probes, lang),
    };
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
