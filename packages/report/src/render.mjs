// Renderings of the daily report: plain text and email-safe HTML, Japanese and English.
// All four come from one model, so they carry the same numbers in the same order. The model is
// built from the summary alone (never from events), so a rendering can show nothing the summary
// does not hold.
import { STRINGS } from "./strings.mjs";
import { REPORT_CLASSES } from "./summarize.mjs";

export const GATE_URL = "https://ludion.ai/gate";

/** 1234567 → "1,234,567" (same in both languages; no locale data needed). */
export const fmt = (n) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "±0");

const num = (key, value, opts = {}) => ({ key, value, ...opts });

/** Sections → rows → cells. A cell is a string, a number {key, value}, or a name {name, nameKey}. */
export function model(s, lang) {
  const L = STRINGS[lang];
  if (!L) throw new Error(`unknown language ${lang}`);
  const sections = [];
  sections.push({ id: "critical", title: L.critical.title, lead: L.critical.lead, rows: [
    [L.critical.unverified, num("critical.unverified", s.critical.unverified, { big: true })],
    [L.critical.allowed, num("critical.allowed", s.critical.allowed)],
    [L.critical.friction, num("critical.friction", s.critical.friction)],
    [L.critical.denied, num("critical.denied", s.critical.denied)],
  ] });
  sections.push({ id: "north", title: L.north.title, lead: L.north.lead, rows: [
    [L.north.verified_actions, num("verified_actions", s.verified_actions, { big: true })],
    [L.north.verified_agents, num("verified_agents", s.verified_agents)],
  ] });
  sections.push({ id: "classes", title: L.classes.title, rows: [
    [L.classes.events, num("events", s.events)],
    ...REPORT_CLASSES.map((c) => [L.classes[c], num(`classes.${c}`, s.classes[c])]),
  ] });
  sections.push({ id: "decisions", title: L.decisions.title, rows: ["allow", "friction", "deny"].map((d) => [L.decisions[d], num(`decisions.${d}`, s.decisions[d])]) });
  sections.push({ id: "kinds", title: L.kinds.title, head: L.kinds.head, rows: Object.entries(s.kinds).map(([k, v]) => [
    L.kinds.names[k] ?? k, num(`kinds.${k}.automation`, v.automation), num(`kinds.${k}.verified`, v.verified), num(`kinds.${k}.denied`, v.denied),
  ]), none: L.kinds.none });
  sections.push({ id: "agents", title: L.agents.title, head: L.agents.head, none: L.agents.none,
    rows: s.top_agents.map((a, i) => [{ name: a.agent, nameKey: `top_agents.${i}.agent` }, num(`top_agents.${i}.actions`, a.actions)]) });
  sections.push({ id: "routes", title: L.routes.title, head: L.routes.head, none: L.routes.none,
    rows: s.top_critical_routes.map((r, i) => [{ name: r.route, nameKey: `top_critical_routes.${i}.route`, code: true }, num(`top_critical_routes.${i}.count`, r.count)]) });
  sections.push(s.pressure1.applies
    ? { id: "pressure1", title: L.pressure1.title, lead: L.pressure1.lead, rows: [
      [L.pressure1.friction, num("pressure1.friction", s.pressure1.friction)],
      [L.pressure1.exempt, num("pressure1.exempt", s.pressure1.exempt)],
    ] }
    : { id: "pressure1", title: L.pressure1.title, rows: [], none: L.pressure1.already });
  const M = ["events", "verified_actions", "critical_unverified", "spoofed"];
  sections.push(s.previous
    ? { id: "previous", title: L.previous.title, head: L.previous.head, rows: M.map((m) => [
      L.previous[m], num(`previous.${m}`, s.previous[m]), num(`delta.${m}`, s.delta[m], { signed: true }),
    ]) }
    : { id: "previous", title: L.previous.title, rows: [], none: L.previous.none });
  if (s.skipped) sections.push({ id: "input", title: L.input.title, rows: [[L.input.skipped, num("skipped", s.skipped)]] });
  return { lang, title: L.title, meta: L.meta(s), subject: subject(s, lang), sections, footer: L.footer, link: L.link };
}

export function subject(s, lang) {
  return STRINGS[lang].subject(s, fmt(s.critical.unverified), fmt(s.verified_actions));
}

const cellText = (c) => (typeof c === "string" ? c : c.name !== undefined ? c.name : c.signed ? signed(c.value) : fmt(c.value));

// ── plain text ────────────────────────────────────────────────────────────────────────────
export function renderText(s, lang) {
  const m = model(s, lang);
  const out = [m.title, m.meta, ""];
  for (const sec of m.sections) {
    out.push(`■ ${sec.title}`);
    if (sec.lead) out.push(sec.lead);
    if (!sec.rows.length) { if (sec.none) out.push(`  ${sec.none}`); out.push(""); continue; }
    if (sec.head) out.push(`  [${sec.head.join(" / ")}]`);
    for (const row of sec.rows) {
      const [first, ...rest] = row;
      out.push(`  ${cellText(first)}　${rest.map(cellText).join(" / ")}`);
    }
    out.push("");
  }
  out.push("—", m.footer, `${m.link}: ${GATE_URL}`);
  return out.join("\n") + "\n";
}

// ── HTML (email-safe: tables, inline styles, no external resources) ─────────────────────────
const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,Helvetica,Arial,sans-serif";
const C = { ink: "#1c1917", muted: "#57534e", line: "#e7e5e4", bg: "#f5f5f4", card: "#ffffff", accent: "#b91c1c", link: "#1d4ed8" };

function htmlCell(c, i, big) {
  const align = i === 0 ? "left" : "right";
  const base = `padding:6px 8px;border-top:1px solid ${C.line};text-align:${align};vertical-align:top;`;
  if (typeof c === "string") return `<td style="${base}">${esc(c)}</td>`;
  if (c.name !== undefined) {
    const inner = c.code ? `<code style="font-family:Menlo,Consolas,monospace;font-size:13px;">${esc(c.name)}</code>` : esc(c.name);
    return `<td data-name="${esc(c.nameKey)}" style="${base}word-break:break-all;">${inner}</td>`;
  }
  const size = c.big ? "font-size:28px;font-weight:700;" : "font-weight:600;";
  const color = c.big && big ? `color:${C.accent};` : "";
  return `<td data-metric="${esc(c.key)}" style="${base}${size}${color}white-space:nowrap;">${esc(cellText(c))}</td>`;
}

export function renderHtml(s, lang) {
  const m = model(s, lang);
  const parts = [];
  parts.push(`<!doctype html>`, `<html lang="${lang}">`, `<head>`, `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<title>${esc(m.subject)}</title>`, `</head>`);
  parts.push(`<body style="margin:0;padding:0;background:${C.bg};">`);
  parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">`);
  parts.push(`<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:1.6;color:${C.ink};">`);
  parts.push(`<tr><td style="padding:20px 24px 8px 24px;"><div style="font-size:20px;font-weight:700;">${esc(m.title)}</div><div style="color:${C.muted};">${esc(m.meta)}</div></td></tr>`);
  for (const sec of m.sections) {
    parts.push(`<tr><td data-section="${esc(sec.id)}" style="padding:16px 24px 8px 24px;">`);
    parts.push(`<div style="font-size:16px;font-weight:700;margin:0 0 4px 0;">${esc(sec.title)}</div>`);
    if (sec.lead) parts.push(`<div style="color:${C.muted};margin:0 0 8px 0;">${esc(sec.lead)}</div>`);
    if (!sec.rows.length) {
      if (sec.none) parts.push(`<div style="color:${C.muted};">${esc(sec.none)}</div>`);
      parts.push(`</td></tr>`);
      continue;
    }
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">`);
    if (sec.head) parts.push(`<tr>${sec.head.map((h, i) => `<th style="padding:6px 8px;text-align:${i === 0 ? "left" : "right"};color:${C.muted};font-weight:600;">${esc(h)}</th>`).join("")}</tr>`);
    for (const row of sec.rows) parts.push(`<tr>${row.map((c, i) => htmlCell(c, i, sec.id === "critical")).join("")}</tr>`);
    parts.push(`</table>`, `</td></tr>`);
  }
  parts.push(`<tr><td style="padding:16px 24px 24px 24px;color:${C.muted};font-size:12px;border-top:1px solid ${C.line};">${esc(m.footer)}<br><a href="${GATE_URL}" style="color:${C.link};">${esc(m.link)}</a></td></tr>`);
  parts.push(`</table>`, `</td></tr></table>`, `</body>`, `</html>`);
  return parts.join("\n") + "\n";
}
