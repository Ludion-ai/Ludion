#!/usr/bin/env node
// Scoreboard: runs every oracle, enforces the ratchet, prints the backlog.
//   npm run scoreboard                  full run → SCOREBOARD.md / SCOREBOARD.json (gitignored)
//   … -- --fast                         level-0 only; everything else from the last full run
//   … -- --brief | --json | --quiet     summary for humans (SessionStart) | for loop.sh | silent
//   … -- --base origin/main             ratchet and ID set read from <ref> (CI), not the working tree
//   … -- --job loop|preview|nightly     run only the oracles of that CI job (the others: ELSEWHERE)
//   … -- --job J --shard i/n --out f    run only shard i of n of job J's oracles (one at a time, as
//                                       always); write their results to f; no verdict (CI, LOOP-2)
//   … -- --job J --merge f1 f2 …        run nothing: merge the shard files, then the usual verdict.
//                                       Every oracle of J must come back exactly once, from shards
//                                       that ran this commit and this verifier (scripts/shard.mjs)
//   npm run ratchet                     full run, then append every PASS to accept/ratchet.json
// Exit 1 when something that once passed no longer does, or an oracle vanished; a ratcheted oracle
// is held to PASS (scripts/ratchet.mjs, LOOP-4). Exit 2 when the --base cannot be read (LOOP-3).
// With --fast, also exit 1 when a level-0 oracle fails (that is what the Stop gate listens to).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ORACLES, ROOT } from "../accept/registry.mjs";
import { readBase, regressions, ciJobs, workflowText, jobOf } from "./ratchet.mjs";
import { FORMAT, parseShard, assignShards, fingerprint, mergeShards } from "./shard.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const FAST = has("--fast"), BRIEF = has("--brief"), JSON_OUT = has("--json"), QUIET = has("--quiet"), UPDATE = has("--update-ratchet");
const JOB = val("--job");
let SHARD = null;
try { SHARD = has("--shard") ? parseShard(val("--shard")) : null; } catch (e) { console.error(e.message); process.exit(2); }
const OUT = val("--out");
// The files after --merge, up to the next flag.
const MERGE = has("--merge") ? argv.slice(argv.indexOf("--merge") + 1).filter((a, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith("--"))) : null;
if (SHARD && !OUT) { console.error("--shard needs --out <file>"); process.exit(2); }
if ((SHARD || MERGE) && (FAST || UPDATE)) { console.error("--shard and --merge are a CI run split in parts: no --fast, no ratchet update"); process.exit(2); }
if (SHARD && MERGE) { console.error("--shard runs oracles, --merge runs none: one or the other"); process.exit(2); }
const RATCHET = path.join(ROOT, "accept/ratchet.json"), CACHE = path.join(ROOT, "SCOREBOARD.json");
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

// The base first: a base that cannot be read stops everything, before any oracle runs (LOOP-3).
let ratchet = readJSON(RATCHET, { passed: [] }).passed ?? [], baseIds = [];
const base = val("--base");
if (base) {
  try { ({ ratchet, ids: baseIds } = readBase(base, (file) => readAt(base, file))); }
  catch (e) { console.error(`ratchet: ${e.message}`); process.exit(2); }
}
function readAt(ref, file) {
  return execFileSync("git", ["show", `${ref}:${file}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64e6 });
}
// A scoreboard started by an oracle (LOOP-3, LOOP-4 start one) never runs oracles itself: no
// recursion. A --merge runs none, so it may; neither writes SCOREBOARD.md over the real one.
const NESTED = !!process.env.LUDION_NESTED_SCOREBOARD;
if (NESTED && !MERGE) { console.error("nested scoreboard: not running oracles"); process.exit(3); }

const cache = readJSON(CACHE, { results: {} });
let results = {};
const inJob = (o) => !JOB || jobOf(o) === JOB;
/** The status an oracle gets without running it, or undefined when it must run. */
function statusWithoutRun(o) {
  const missing = (o.needs ?? []).filter((e) => !process.env[e]);
  if (!o.run) return { status: "PENDING", ...(missing.length ? { human: missing } : {}) };
  if (!inJob(o)) return { status: "ELSEWHERE", job: jobOf(o) };
  if (FAST && (o.level ?? 1) > 0) return { ...(cache.results?.[o.id] ?? { status: "UNRUN" }), cached: true };
  if (missing.length) return { status: "SKIP", human: missing };
}
async function runOracle(o) {
  const t = Date.now(), limit = o.timeoutMs ?? 300_000;
  try {
    const r = await Promise.race([o.run(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${limit}ms`)), limit).unref())]);
    return { status: r.pass ? "PASS" : "FAIL", metric: r.metric, detail: r.detail, ms: Date.now() - t };
  } catch (e) { return { status: "FAIL", detail: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t }; }
}
const headSha = () => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; } };
const line = (o, r) => `${r.status.padEnd(8)} ${o.id.padEnd(7)} ${o.m}  ${o.title}${r.metric ? `  [${r.metric}]` : ""}${r.detail ? `  — ${r.detail}` : ""}${r.ms != null ? `  (${(r.ms / 1000).toFixed(1)}s)` : ""}`;

let mergeProblems = [];
if (MERGE) {
  // Nothing runs here: the shards did. The job's oracles come from them, the rest as always.
  const merged = mergeShards(MERGE, { oracles: ORACLES.filter(inJob), sha: headSha(), print: fingerprint(ROOT), job: JOB ?? null });
  mergeProblems = merged.problems;
  for (const o of ORACLES) results[o.id] = inJob(o) ? merged.results[o.id] : statusWithoutRun(o);
} else if (SHARD) {
  const startedAt = new Date().toISOString();
  const weights = readJSON(path.join(ROOT, "scripts/shard-weights.json"), { ms: {} }).ms ?? {};
  const assigned = assignShards(ORACLES.filter(inJob), SHARD.n, weights);
  const mine = ORACLES.filter((o) => inJob(o) && assigned[o.id] === SHARD.i);
  for (const o of mine) results[o.id] = statusWithoutRun(o) ?? await runOracle(o);
  // A shard gives no verdict: the merge does, over every shard, with the base's ratchet.
  fs.writeFileSync(OUT, JSON.stringify({ format: FORMAT, sha: headSha(), fingerprint: fingerprint(ROOT), job: JOB ?? null, shard: SHARD,
    ids: mine.map((o) => o.id), results, startedAt, finishedAt: new Date().toISOString(), platform: process.platform, node: process.version }, null, 1) + "\n");
  if (!QUIET) for (const o of mine) console.log(line(o, results[o.id]));
  console.log(`shard ${SHARD.i}/${SHARD.n}${JOB ? ` of job ${JOB}` : ""}: ${mine.length} oracles → ${OUT}`);
  process.exit(0);
} else {
  for (const o of ORACLES) results[o.id] = statusWithoutRun(o) ?? await runOracle(o);
}
for (const o of ORACLES.filter((x) => x.retired)) {
  const open = (o.retireWhen ?? []).filter((id) => results[id]?.status !== "PASS");
  results[o.id] = open.length ? { status: "FAIL", detail: `retired early; still open: ${open.join(", ")}` } : { status: "RETIRED" };
}

const ids = new Set(ORACLES.map((o) => o.id));
const regressed = [...mergeProblems, ...regressions({ ratchet, results, ids, baseIds, fast: FAST, jobs: JOB ? ciJobs(workflowText(ROOT)) : null })];
// MISSION.md §1.4: a positive that passes without its negative (or with none) is not yet trustworthy.
const warnings = [
  ...ORACLES.filter((o) => o.pair && results[o.id]?.status === "PASS" && !["PASS", "ELSEWHERE"].includes(results[o.pair]?.status))
    .map((o) => `${o.id} passes but its pair ${o.pair} is ${results[o.pair]?.status ?? "missing"}`),
  ...ORACLES.filter((o) => o.kind === "+" && !o.pair && results[o.id]?.status === "PASS")
    .map((o) => `${o.id} passes with no negative oracle of the same property`),
];

const count = (s) => Object.values(results).filter((r) => r.status === s).length;
const human = ORACLES.filter((o) => results[o.id].human?.length);
const order = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"];
const open = ORACLES.filter((o) => ["FAIL", "PENDING"].includes(results[o.id].status) && !results[o.id].human)
  .sort((a, b) => (results[b.id].status === "FAIL") - (results[a.id].status === "FAIL") || order.indexOf(a.m) - order.indexOf(b.m));
const summary = { pass: count("PASS"), fail: count("FAIL"), pending: count("PENDING"), skip: count("SKIP"), unrun: count("UNRUN"), elsewhere: count("ELSEWHERE"),
  retired: count("RETIRED"), human: human.length, autonomous: open.length, total: ORACLES.length, regressions: regressed, warnings,
  next: open.slice(0, 5).map((o) => `${o.id} ${results[o.id].status} (${o.m}) ${o.title}`) };

if (!FAST && !NESTED) {
  // One CI job's run is not the whole picture: the cache (read by --fast) is written by full runs only.
  if (!JOB) fs.writeFileSync(CACHE, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
  const icon = { PASS: "✅", FAIL: "❌", PENDING: "⬜", SKIP: "⏸", RETIRED: "➖", UNRUN: "·", ELSEWHERE: "↪" };
  const md = [
    `# Scoreboard ${new Date().toISOString()}`, "",
    `PASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / SKIP ${summary.skip}${JOB ? ` / in other CI jobs ${summary.elsewhere} (this is job ${JOB})` : ""} / total ${summary.total}`, "",
    ...(regressed.length ? ["## Regressions (ratchet)", ...regressed.map((r) => `- ${r}`), ""] : []),
    ...(warnings.length ? ["## Unpaired passes (not yet trustworthy)", ...warnings.map((w) => `- ${w}`), ""] : []),
    "| id | m | ± | status | metric | oracle |", "|---|---|---|---|---|---|",
    ...ORACLES.map((o) => { const r = results[o.id]; return `| ${o.id} | ${o.m} | ${o.kind} | ${icon[r.status]} ${r.status} | ${r.metric ?? ""} | ${o.title}${r.human ? ` (needs ${r.human.join(", ")})` : ""}${r.detail ? ` — ${r.detail}` : ""} |`; }),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(ROOT, "SCOREBOARD.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (UPDATE) {
  if (FAST || JOB) { console.error("--update-ratchet needs a full run of every oracle"); process.exit(2); }
  if (regressed.length) console.error("ratchet not updated: fix regressions first");
  else {
    const passed = [...new Set([...(readJSON(RATCHET, { passed: [] }).passed ?? []), ...ORACLES.filter((o) => results[o.id].status === "PASS").map((o) => o.id)])].sort();
    fs.writeFileSync(RATCHET, JSON.stringify({ note: "Append-only. Written by `npm run ratchet`. CI enforces it from the base branch.", passed }, null, 2) + "\n");
    console.error(`ratchet: ${passed.length} oracles locked`);
  }
}

if (JSON_OUT) console.log(JSON.stringify(summary));
else if (BRIEF) console.log([
  `Ludion scoreboard${FAST ? " (level 0 live, rest from last full run)" : ""}: PASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / waiting on a human ${summary.human} / total ${summary.total}`,
  regressed.length ? `REGRESSIONS: ${regressed.join("; ")}` : "Ratchet holding.",
  warnings.length ? `Unpaired: ${warnings.join("; ")}` : null,
  `Next: ${summary.next.join(" | ") || "nothing autonomous left"}`,
  human.length ? `Waiting on a human: ${human.map((o) => `${o.id} (${results[o.id].human.join(", ")})`).join(", ")}` : null,
].filter(Boolean).join("\n"));
else if (!QUIET) {
  for (const o of ORACLES) console.log(line(o, results[o.id]));
  console.log(`\nPASS ${summary.pass} / FAIL ${summary.fail} / PENDING ${summary.pending} / SKIP ${summary.skip}${JOB ? ` / in other CI jobs ${summary.elsewhere}` : ""} / total ${summary.total}`);
  for (const r of regressed) console.log(`REGRESSION ${r}`);
  for (const w of warnings) console.log(`UNPAIRED   ${w}`);
} else for (const r of regressed) console.log(`REGRESSION ${r}`);

const l0red = ORACLES.some((o) => (o.level ?? 1) === 0 && results[o.id].status === "FAIL");
process.exit(regressed.length || (FAST && l0red) ? 1 : 0);
