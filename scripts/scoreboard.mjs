#!/usr/bin/env node
// Scoreboard: runs every oracle, enforces the ratchet, prints the backlog.
//   npm run scoreboard                  full run → SCOREBOARD.md / SCOREBOARD.json (gitignored)
//   … -- --fast                         level-0 only; everything else from the last full run
//   … -- --brief | --json | --quiet     summary for humans (SessionStart) | for loop.sh | silent
//   … -- --base origin/main             ratchet and ID set read from <ref> (CI), not the working tree
//   npm run ratchet                     full run, then append every PASS to accept/ratchet.json
// Exit 1 when something that once passed no longer does, or an oracle vanished.
// With --fast, also exit 1 when a level-0 oracle fails (that is what the Stop gate listens to).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ORACLES, ROOT } from "../accept/registry.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const FAST = has("--fast"), BRIEF = has("--brief"), JSON_OUT = has("--json"), QUIET = has("--quiet"), UPDATE = has("--update-ratchet");
const RATCHET = path.join(ROOT, "accept/ratchet.json"), CACHE = path.join(ROOT, "SCOREBOARD.json");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

let ratchet = readJSON(RATCHET, { passed: [] }).passed ?? [], baseIds = [];
const base = val("--base");
if (base) {
  try { ratchet = JSON.parse(git("show", `${base}:accept/ratchet.json`)).passed ?? []; } catch { ratchet = []; }
  try { baseIds = [...git("show", `${base}:accept/registry.mjs`).matchAll(/\bid:\s*"([A-Z]{2,5}-\d+)"/g)].map((m) => m[1]); } catch { baseIds = []; }
}

const cache = readJSON(CACHE, { results: {} });
const results = {};
for (const o of ORACLES) {
  const missing = (o.needs ?? []).filter((e) => !process.env[e]);
  if (!o.run) { results[o.id] = { status: "PENDING", ...(missing.length ? { human: missing } : {}) }; continue; }
  if (missing.length) { results[o.id] = { status: "SKIP", human: missing }; continue; }
  if (FAST && (o.level ?? 1) > 0) { results[o.id] = { ...(cache.results?.[o.id] ?? { status: "UNRUN" }), cached: true }; continue; }
  const t = Date.now(), limit = o.timeoutMs ?? 300_000;
  try {
    const r = await Promise.race([o.run(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${limit}ms`)), limit).unref())]);
    results[o.id] = { status: r.pass ? "PASS" : "FAIL", metric: r.metric, detail: r.detail, ms: Date.now() - t };
  } catch (e) { results[o.id] = { status: "FAIL", detail: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t }; }
}
for (const o of ORACLES.filter((x) => x.retired)) {
  const open = (o.retireWhen ?? []).filter((id) => results[id]?.status !== "PASS");
  results[o.id] = open.length ? { status: "FAIL", detail: `retired early; still open: ${open.join(", ")}` } : { status: "RETIRED" };
}

const ids = new Set(ORACLES.map((o) => o.id));
const regressions = [];
for (const id of ratchet) {
  const r = results[id];
  if (!r) regressions.push(`${id} removed`);
  else if (r.status === "FAIL" || r.status === "PENDING") regressions.push(`${id} ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
}
for (const id of baseIds) if (!ids.has(id)) regressions.push(`${id} deleted from the registry`);
const warnings = ORACLES.filter((o) => o.pair && results[o.id]?.status === "PASS" && results[o.pair]?.status !== "PASS")
  .map((o) => `${o.id} passes but its pair ${o.pair} is ${results[o.pair]?.status ?? "missing"}`);

const count = (s) => Object.values(results).filter((r) => r.status === s).length;
const human = ORACLES.filter((o) => results[o.id].human?.length);
const order = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"];
const open = ORACLES.filter((o) => ["FAIL", "PENDING"].includes(results[o.id].status) && !results[o.id].human)
  .sort((a, b) => (results[b.id].status === "FAIL") - (results[a.id].status === "FAIL") || order.indexOf(a.m) - order.indexOf(b.m));
const summary = { pass: count("PASS"), fail: count("FAIL"), pending: count("PENDING"), skip: count("SKIP"), unrun: count("UNRUN"),
  retired: count("RETIRED"), human: human.length, autonomous: open.length, total: ORACLES.length, regressions, warnings,
  next: open.slice(0, 5).map((o) => `${o.id} ${results[o.id].status} (${o.m}) ${o.title}`) };

if (!FAST) {
  fs.writeFileSync(CACHE, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
  const icon = { PASS: "✅", FAIL: "❌", PENDING: "⬜", SKIP: "⏸", RETIRED: "➖", UNRUN: "·" };
  const md = [
    `# Scoreboard ${new Date().toISOString()}`, "",
    `PASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / SKIP ${summary.skip} / total ${summary.total}`, "",
    ...(regressions.length ? ["## Regressions (ratchet)", ...regressions.map((r) => `- ${r}`), ""] : []),
    ...(warnings.length ? ["## Unpaired passes (not yet trustworthy)", ...warnings.map((w) => `- ${w}`), ""] : []),
    "| id | m | ± | status | metric | oracle |", "|---|---|---|---|---|---|",
    ...ORACLES.map((o) => { const r = results[o.id]; return `| ${o.id} | ${o.m} | ${o.kind} | ${icon[r.status]} ${r.status} | ${r.metric ?? ""} | ${o.title}${r.human ? ` (needs ${r.human.join(", ")})` : ""}${r.detail ? ` — ${r.detail}` : ""} |`; }),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(ROOT, "SCOREBOARD.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (UPDATE) {
  if (FAST) { console.error("--update-ratchet needs a full run"); process.exit(2); }
  if (regressions.length) console.error("ratchet not updated: fix regressions first");
  else {
    const passed = [...new Set([...(readJSON(RATCHET, { passed: [] }).passed ?? []), ...ORACLES.filter((o) => results[o.id].status === "PASS").map((o) => o.id)])].sort();
    fs.writeFileSync(RATCHET, JSON.stringify({ note: "Append-only. Written by `npm run ratchet`. CI enforces it from the base branch.", passed }, null, 2) + "\n");
    console.error(`ratchet: ${passed.length} oracles locked`);
  }
}

if (JSON_OUT) console.log(JSON.stringify(summary));
else if (BRIEF) console.log([
  `Ludion scoreboard${FAST ? " (level 0 live, rest from last full run)" : ""}: PASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / waiting on a human ${summary.human} / total ${summary.total}`,
  regressions.length ? `REGRESSIONS: ${regressions.join("; ")}` : "Ratchet holding.",
  warnings.length ? `Unpaired: ${warnings.join("; ")}` : null,
  `Next: ${summary.next.join(" | ") || "nothing autonomous left"}`,
  human.length ? `Waiting on a human: ${human.map((o) => `${o.id} (${results[o.id].human.join(", ")})`).join(", ")}` : null,
].filter(Boolean).join("\n"));
else if (!QUIET) {
  for (const o of ORACLES) { const r = results[o.id]; console.log(`${r.status.padEnd(8)} ${o.id.padEnd(7)} ${o.m}  ${o.title}${r.metric ? `  [${r.metric}]` : ""}${r.detail ? `  — ${r.detail}` : ""}`); }
  console.log(`\nPASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / SKIP ${summary.skip} / total ${summary.total}`);
  for (const r of regressions) console.log(`REGRESSION ${r}`);
  for (const w of warnings) console.log(`UNPAIRED   ${w}`);
} else for (const r of regressions) console.log(`REGRESSION ${r}`);

const l0red = ORACLES.some((o) => (o.level ?? 1) === 0 && results[o.id].status === "FAIL");
process.exit(regressions.length || (FAST && l0red) ? 1 : 0);
