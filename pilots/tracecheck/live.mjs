#!/usr/bin/env node
// PILOT-2 (L2): tracecheck.dev's Gate has been recording. Reads the pilot's D1 through the Cloudflare
// API, read-only, and checks the last `--days` (default 7) complete days in Tokyo: each has recorded
// automation and a saved morning report. Prints `ok …` lines, and exits 1 on a gap.
//
//   TRACECHECK_D1_READ_TOKEN   an API token of the tracecheck.dev account that can read D1 (a person makes it)
//   TRACECHECK_ACCOUNT_ID      that account's ID
//   TRACECHECK_D1_ID           the ID of the `ludion-tracecheck` database (`npx wrangler d1 info ludion-tracecheck`)
import { dateIn, addDays, dayWindow } from "@ludion/report";

const TZ = "Asia/Tokyo", SITE = "tracecheck.dev";
const days = Number((/--days[= ](\d+)/.exec(process.argv.slice(2).join(" ")) ?? [])[1] ?? 7);
const { TRACECHECK_D1_READ_TOKEN: token, TRACECHECK_ACCOUNT_ID: account, TRACECHECK_D1_ID: db } = process.env;
if (!token || !account || !db) {
  console.error("needs TRACECHECK_D1_READ_TOKEN, TRACECHECK_ACCOUNT_ID and TRACECHECK_D1_ID");
  process.exit(2);
}

async function query(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`D1 query answered ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
  return body.result[0].results;
}

const today = dateIn(TZ);
// Yesterday's report is written at 07:00 in Tokyo (wrangler.jsonc): before 08:00, the last full day is the day before.
const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const last = hour < 8 ? 2 : 1;
const problems = [];
for (let i = days + last - 1; i >= last; i--) {
  const date = addDays(today, -i);
  const w = dayWindow(date, TZ);
  const [{ n, verified }] = await query("SELECT count(*) AS n, sum(class = 'VERIFIED') AS verified FROM events WHERE site = ? AND ts >= ? AND ts < ?",
    [SITE, Math.floor(w.start / 1000), Math.floor(w.end / 1000)]);
  const reports = await query("SELECT lang FROM reports WHERE site = ? AND date = ?", [SITE, date]);
  const langs = reports.map((r) => r.lang).sort().join(",");
  if (!n) problems.push(`${date}: no automation recorded`);
  if (langs !== "en,ja") problems.push(`${date}: morning report ${langs || "missing"}`);
  if (n && langs === "en,ja") console.log(`ok ${date}: ${n} automated requests recorded (${verified ?? 0} VERIFIED), report saved`);
}
if (problems.length) { console.log(problems.map((p) => `not ok ${p}`).join("\n")); process.exit(1); }
console.log(`ok ${days} days of records and reports for ${SITE}`);
