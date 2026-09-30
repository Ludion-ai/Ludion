#!/usr/bin/env node
// Scoreboard: runs every oracle, enforces the ratchet, prints the backlog.
//   npm run scoreboard                  full run → SCOREBOARD.md / SCOREBOARD.json (gitignored)
//   … -- --fast                         level-0 only; everything else from the last full run
//   … -- --brief | --json | --quiet     summary for humans (SessionStart) | for loop.sh | silent
//   … -- --base origin/main             ratchet and ID set read from <ref> (CI), not the working tree
//   … -- --jobs N                       oracles run N at a time (default: CPUs, max 8); `exclusive`
//                                       oracles then run alone. --jobs 1 = strictly one after another
//   … -- --shard i/n --out f.json       run only shard i of n (CI); writes the shard's results, no verdict
//   … -- --merge f1.json f2.json …      no oracle runs: merge shard files, then the usual verdict. Every
//                                       ID must come back exactly once, same commit, same verifier
//   … -- --merge … --judge [--expect-sha S]  the base branch's scoreboard judging a PR's shards: the
//                                       shards must agree with each other (and on S); every oracle of
//                                       this (base) registry must be among them; oracles added are allowed
//   npm run ratchet                     full run, then append every PASS to accept/ratchet.json
// Exit 1 when something that once passed no longer does, or an oracle vanished.
// With --fast, also exit 1 when a level-0 oracle fails (that is what the Stop gate listens to).
// An oracle over its own cap (timeoutMs) has every process tree it started killed and is FAIL
// "timeout after Ns (process tree killed); last output: …".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ORACLES, ROOT } from "../accept/registry.mjs";
import { oracleScope, killTree, lastLines } from "./proc.mjs";
import { FORMAT, parseShard, assignShards, fingerprint, mergeShards } from "./shard.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const FAST = has("--fast"), BRIEF = has("--brief"), JSON_OUT = has("--json"), QUIET = has("--quiet"), UPDATE = has("--update-ratchet");
const JOBS = Math.max(1, Math.min(16, Math.floor(Number(val("--jobs") ?? Math.min(os.availableParallelism?.() ?? os.cpus().length, 8))) || 1));
const SHARD = has("--shard") ? parseShard(val("--shard")) : null, OUT = val("--out");
const MERGE = has("--merge") ? argv.slice(argv.indexOf("--merge") + 1).filter((a, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith("--"))) : null;
const JUDGE = has("--judge"), EXPECT_SHA = val("--expect-sha");
if (SHARD && !OUT) { console.error("--shard needs --out <file>"); process.exit(2); }
if (SHARD && (MERGE || FAST || UPDATE)) { console.error("--shard runs one slice of a full run: no --merge, --fast or ratchet"); process.exit(2); }
if (JUDGE && !MERGE) { console.error("--judge judges shard files: it needs --merge"); process.exit(2); }
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
let results = {};

/** Status an oracle gets without running, or undefined when it must run. */
function statusWithoutRun(o) {
  const missing = (o.needs ?? []).filter((e) => !process.env[e]);
  if (!o.run) return { status: "PENDING", ...(missing.length ? { human: missing } : {}) };
  if (missing.length) return { status: "SKIP", human: missing };
  if (FAST && (o.level ?? 1) > 0) return { ...(cache.results?.[o.id] ?? { status: "UNRUN" }), cached: true };
}
const TIMED_OUT = Symbol("timeout");
async function runOracle(o) {
  const t = Date.now(), limit = o.timeoutMs ?? 300_000;
  const scope = new Set(); // every child the oracle starts through scripts/proc.mjs
  try {
    let timer;
    const r = await Promise.race([oracleScope.run(scope, () => o.run()), new Promise((res) => { timer = setTimeout(() => res(TIMED_OUT), limit); timer.unref(); })])
      .finally(() => clearTimeout(timer));
    if (r === TIMED_OUT) {
      // The oracle's own cap: kill every process tree it started, and say where it stood.
      const tail = [...scope].map((c) => lastLines(c.output())).filter(Boolean).join(" || ");
      for (const c of scope) killTree(c.child);
      return { status: "FAIL", detail: `timeout after ${Math.round(limit / 1000)}s (process tree killed); last output: ${tail || "(none)"}`.slice(0, 300), ms: Date.now() - t };
    }
    return { status: r.pass ? "PASS" : "FAIL", metric: r.metric, detail: r.detail, ms: Date.now() - t };
  } catch (e) { return { status: "FAIL", detail: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t }; }
}
/** Run async tasks, at most n at a time. */
async function pool(tasks, n) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (next < tasks.length) await tasks[next++](); }));
}

const startedAt = new Date().toISOString();
const headSha = () => { try { return git("rev-parse", "HEAD").trim(); } catch { return "unknown"; } };
const weights = readJSON(path.join(ROOT, "scripts/shard-weights.json"), { ms: {} }).ms ?? {};
const assigned = SHARD ? assignShards(ORACLES, SHARD.n, weights) : null;
const mine = ORACLES.filter((o) => !assigned || assigned[o.id] === SHARD.i);
let mergeProblems = [], judgedExtra = [];

const toRun = [];
if (MERGE) ({ results, problems: mergeProblems, extra: judgedExtra } = mergeShards(MERGE, JUDGE
  ? { oracles: ORACLES, sha: EXPECT_SHA, judge: true }
  : { oracles: ORACLES, sha: headSha(), print: fingerprint(ROOT) }));
else for (const o of mine) { const s = statusWithoutRun(o); if (s) results[o.id] = s; else toRun.push(o); }
if (MERGE) { /* nothing runs: the shards did */ } else if (JOBS === 1) {
  for (const o of toRun) results[o.id] = await runOracle(o); // today's behaviour, registry order
} else {
  // Parallel phase: every non-exclusive oracle, plus the installs exclusive ones prepare. Longest
  // first (by the last recorded time) so the slowest start early. Then each exclusive oracle alone.
  const lastMs = (o) => cache.results?.[o.id]?.ms ?? 0;
  const shared = toRun.filter((o) => !o.exclusive).sort((a, b) => lastMs(b) - lastMs(a));
  const exclusive = toRun.filter((o) => o.exclusive);
  await pool([
    ...exclusive.filter((o) => o.prepare).map((o) => async () => { try { await oracleScope.run(new Set(), () => o.prepare()); } catch { /* the run prepares again and reports */ } }),
    ...shared.map((o) => async () => { results[o.id] = await runOracle(o); }),
  ], JOBS);
  for (const o of exclusive) results[o.id] = await runOracle(o);
}
results = Object.fromEntries(ORACLES.filter((o) => results[o.id]).map((o) => [o.id, results[o.id]])); // registry order

if (SHARD) {
  // A shard gives no verdict: the merge step does, over all shards, with the base ratchet.
  fs.writeFileSync(OUT, JSON.stringify({ format: FORMAT, sha: headSha(), fingerprint: fingerprint(ROOT), shard: SHARD,
    ids: mine.map((o) => o.id), results, startedAt, finishedAt: new Date().toISOString(), platform: process.platform, node: process.version, jobs: JOBS }, null, 1));
  if (!QUIET) for (const o of mine) { const r = results[o.id]; console.log(`${r.status.padEnd(8)} ${o.id.padEnd(7)} ${o.m}  ${o.title}${r.metric ? `  [${r.metric}]` : ""}${r.detail ? `  — ${r.detail}` : ""}`); }
  console.log(`shard ${SHARD.i}/${SHARD.n}: ${mine.length} oracles → ${OUT}`);
  process.exit(0);
}
if (JUDGE && judgedExtra.length) console.error(`judge: ${judgedExtra.length} oracle(s) the PR added are not in this base registry, so the base judges them not at all: ${judgedExtra.join(", ")}`);
for (const o of ORACLES.filter((x) => x.retired)) {
  const open = (o.retireWhen ?? []).filter((id) => results[id]?.status !== "PASS");
  results[o.id] = open.length ? { status: "FAIL", detail: `retired early; still open: ${open.join(", ")}` } : { status: "RETIRED" };
}

const ids = new Set(ORACLES.map((o) => o.id));
const regressions = [...mergeProblems];
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
