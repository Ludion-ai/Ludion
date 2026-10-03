#!/usr/bin/env node
// SCAN-4 (+, pair SCAN-6, property scan-throughput): 1 GiB of access logs through `ludion scan` in ≤60 s.
//
// Generates 1 GiB of nginx `main` lines into a temp dir (not timed, deleted afterwards), then
// times the real CLI end to end — process start, read, parse, classify, aggregate, render —
// and checks that it did all the work: every line counted, every class equal to what was
// written. Paths carry fresh IDs, so route caches do not flatter the number.
//   node packages/scan/bench/scan4.mjs [--bytes N] [--limit-s 60] [--cli path]
// --cli times another CLI in place of ludion's: SCAN-6 plants fakes there to prove these checks bite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const BYTES = opt("--bytes", 1024 ** 3), LIMIT_S = opt("--limit-s", 60);
const CLI = argv.includes("--cli") ? path.resolve(argv[argv.indexOf("--cli") + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../diver/bin/ludion.mjs");

let a = 0x5ca4;
const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const UAS = [
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "UNKNOWN", 50],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "UNKNOWN", 20],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", "DECLARED", 8],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "DECLARED", 8],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "DECLARED", 4],
  ["python-requests/2.32.3", "SUSPECTED", 5],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36", "SUSPECTED", 3],
  ["-", "SUSPECTED", 2],
];
const UA_TOTAL = UAS.reduce((n, u) => n + u[2], 0);
const ROUTES = [["GET", "/products/"], ["GET", "/blog/post-"], ["GET", "/search?q="], ["POST", "/login"], ["GET", "/cart/"], ["GET", "/static/app."], ["POST", "/api/v1/items/"], ["GET", "/"]];

function pickUa() {
  let t = rnd() * UA_TOTAL;
  for (const u of UAS) if ((t -= u[2]) < 0) return u;
  return UAS[0];
}

function generate(file) {
  const fd = fs.openSync(file, "w");
  const counts = { UNKNOWN: 0, DECLARED: 0, SUSPECTED: 0 };
  let written = 0, lines = 0, sec = Date.UTC(2026, 8, 29) / 1000;
  const MON = "Sep";
  try {
    while (written < BYTES) {
      let chunk = "";
      while (chunk.length < 4 << 20) {
        const [ua, cls] = pickUa();
        const [m, p] = ROUTES[(rnd() * ROUTES.length) | 0];
        const id = ((rnd() * 1e9) | 0).toString(36);
        sec += rnd() < 0.3 ? 1 : 0;
        const d = new Date(sec * 1000);
        const ts = `${String(d.getUTCDate()).padStart(2, "0")}/${MON}/2026:${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} +0000`;
        const ip = `198.${18 + ((rnd() * 2) | 0)}.${(rnd() * 256) | 0}.${1 + ((rnd() * 254) | 0)}`;
        chunk += `${ip} - - [${ts}] "${m} ${p}${id} HTTP/1.1" ${rnd() < 0.9 ? 200 : 404} ${(rnd() * 50000) | 0} "-" "${ua}" "-"\n`;
        counts[cls]++;
        lines++;
      }
      written += fs.writeSync(fd, chunk);
    }
  } finally { fs.closeSync(fd); }
  return { written, lines, counts };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-scan4-"));
let result;
try {
  const file = path.join(dir, "access.log");
  const g0 = Date.now();
  const gen = generate(file);
  console.log(`# generated ${(gen.written / 1024 ** 2).toFixed(0)} MiB, ${gen.lines} lines in ${((Date.now() - g0) / 1000).toFixed(1)}s (not timed)`);
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, "scan", file, "--json"], { encoding: "utf8", maxBuffer: 64e6, timeout: (LIMIT_S * 3) * 1000 });
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const problems = [];
  if (r.status !== 0) problems.push(`scan exited ${r.status}: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  let rep = null;
  try { rep = JSON.parse(r.stdout); } catch { problems.push("no JSON report"); }
  if (rep) {
    if (rep.totals.records !== gen.lines) problems.push(`records ${rep.totals.records} ≠ ${gen.lines} written`);
    if (rep.totals.parsed !== gen.lines) problems.push(`parsed ${rep.totals.parsed} ≠ ${gen.lines}`);
    for (const [c, n] of Object.entries(gen.counts)) if (rep.classes[c] !== n) problems.push(`${c} ${rep.classes[c]} ≠ ${n}`);
  }
  if (seconds > LIMIT_S) problems.push(`${seconds.toFixed(1)}s > ${LIMIT_S}s`);
  const mbps = gen.written / 1e6 / seconds;
  result = { pass: problems.length === 0, bytes: gen.written, lines: gen.lines, seconds: Math.round(seconds * 100) / 100, mbps: Math.round(mbps), problems };
  if (result.pass) console.log(`ok 1 - ${(gen.written / 1024 ** 3).toFixed(2)} GiB scanned in ${seconds.toFixed(1)}s (${Math.round(mbps)} MB/s), every line counted`);
  else console.log(`not ok 1 - ${problems.join("; ")}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
process.exit(result.pass ? 0 : 1);
