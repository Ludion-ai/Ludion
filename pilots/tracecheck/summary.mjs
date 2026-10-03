#!/usr/bin/env node
// The pilot's records over a span of days (the week before the launch): the same counting as the
// daily report (@ludion/report's count), over the whole span, plus each day's totals and the
// pilot's extras (who named themselves, who signed, why signatures failed, their lifetimes).
//
//   node pilots/tracecheck/summary.mjs --from 2026-10-04 --to 2026-10-10 [--rows rows.json] [--json]
//
// Rows come from a file: what `npx wrangler d1 execute ludion-tracecheck --remote --json --command
// "SELECT * FROM events WHERE ts >= …"` prints. Without --rows they are read through the Cloudflare
// API with PILOT-2's read-only token (TRACECHECK_D1_READ_TOKEN, TRACECHECK_ACCOUNT_ID, TRACECHECK_D1_ID).
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readEvent, count, dayWindow, addDays, isValidDate, fmt } from "@ludion/report";
import { extras, probeLines } from "./src/daily.mjs";
import { COLUMNS } from "./src/observe.mjs";

const TZ = "Asia/Tokyo", SITE = "tracecheck.dev";

/** Rows as `wrangler d1 execute --json` prints them ([{ results: [...] }]) or a plain array. */
export function rowsOf(json) {
  const v = typeof json === "string" ? JSON.parse(json) : json;
  if (Array.isArray(v) && v.length && Array.isArray(v[0]?.results)) return v.flatMap((r) => r.results);
  if (Array.isArray(v)) return v;
  throw new TypeError("not D1 rows: expected wrangler's --json output or an array of rows");
}

/**
 * @param {object[]} rows   events rows (store.mjs columns)
 * @param {{ from: string, to: string, tz?: string, site?: string }} span  dates inclusive, in `tz`
 */
export function summarizeSpan(rows, { from, to, tz = TZ, site = SITE }) {
  const start = dayWindow(from, tz).start, end = dayWindow(to, tz).end;
  const mine = rows.filter((r) => r.site === site && r.ts * 1000 >= start && r.ts * 1000 < end);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const w = dayWindow(d, tz);
    const day = mine.filter((r) => r.ts * 1000 >= w.start && r.ts * 1000 < w.end);
    const c = count(day.map(readEvent).filter(Boolean));
    days.push({ date: d, events: c.events, verified: c.classes.VERIFIED, declared: c.classes.DECLARED, suspected: c.classes.SUSPECTED, critical_unverified: c.critical.unverified });
  }
  const lifetimes = {};
  for (const r of mine) if (r.sig_lifetime != null) lifetimes[r.sig_lifetime] = (lifetimes[r.sig_lifetime] ?? 0) + 1;
  return { site, tz, from, to, days, ...count(mine.map(readEvent).filter(Boolean)), pilot: { ...extras(mine), lifetimes } };
}

const list = (items, n = 8) => (items.length ? items.slice(0, n).map((i) => `${i.key} ${fmt(i.count)}`).join("、") : "なし");

/** Japanese text for the person writing the launch post. Numbers only from the summary. */
export function renderSummary(s) {
  const c = s.classes;
  return [
    `${s.site}：${s.from}〜${s.to}（${s.tz}）`,
    `自動化 ${fmt(s.events)} 件：VERIFIED ${fmt(c.VERIFIED)}・UNVERIFIED ${fmt(c.UNVERIFIED)}・SPOOFED ${fmt(c.SPOOFED)}・REVOKED ${fmt(c.REVOKED)}・DECLARED ${fmt(c.DECLARED)}・SUSPECTED ${fmt(c.SUSPECTED)}`,
    `重要経路に触れた未検証の自動化：${fmt(s.critical.unverified)} 件`,
    `検証済みのエージェント：${s.top_agents.length ? s.top_agents.map((a) => `${a.agent} ${fmt(a.actions)}`).join("、") : "なし"}`,
    `User-Agent で名乗った運営者：${list(s.pilot.declared)}`,
    `署名してきたエージェント：${list(s.pilot.signers)}`,
    `検証できなかった署名：${list(s.pilot.unverified)}`,
    `署名の寿命（秒）：${Object.entries(s.pilot.lifetimes).map(([k, v]) => `${k} ${fmt(v)}`).join("、") || "なし"}`,
    ...probeLines(s.pilot.probes, "ja"),
    "",
    "日ごと（自動化 / VERIFIED / DECLARED / SUSPECTED / 重要経路の未検証）：",
    ...s.days.map((d) => `  ${d.date}  ${fmt(d.events)} / ${fmt(d.verified)} / ${fmt(d.declared)} / ${fmt(d.suspected)} / ${fmt(d.critical_unverified)}`),
  ].join("\n") + "\n";
}

async function fromApi(from, to) {
  const { TRACECHECK_D1_READ_TOKEN: token, TRACECHECK_ACCOUNT_ID: account, TRACECHECK_D1_ID: db } = process.env;
  if (!token || !account || !db) throw new Error("give --rows <file>, or set TRACECHECK_D1_READ_TOKEN, TRACECHECK_ACCOUNT_ID and TRACECHECK_D1_ID");
  const lo = Math.floor(dayWindow(from, TZ).start / 1000), hi = Math.floor(dayWindow(to, TZ).end / 1000);
  const out = [];
  let ts = lo, row = -1;
  for (;;) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ sql: `SELECT rowid AS _row, ${COLUMNS.join(", ")} FROM events WHERE ts >= ?1 AND ts < ?2 AND (ts > ?1 OR rowid > ?3) ORDER BY ts, rowid LIMIT 5000`, params: [ts, hi, row] }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(`D1 query answered ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
    const results = body.result[0].results;
    for (const r of results) { ts = r.ts; row = r._row; delete r._row; out.push(r); }
    if (results.length < 5000) return out;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const from = flag("from"), to = flag("to");
  if (!isValidDate(from ?? "") || !isValidDate(to ?? "") || from > to) {
    console.error("usage: node pilots/tracecheck/summary.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--rows rows.json] [--json]");
    process.exit(2);
  }
  const rows = flag("rows") ? rowsOf(fs.readFileSync(flag("rows"), "utf8")) : await fromApi(from, to);
  const s = summarizeSpan(rows, { from, to });
  process.stdout.write(args.includes("--json") ? JSON.stringify(s, null, 2) + "\n" : renderSummary(s));
}
