// LOOP-3 and LOOP-4 (Codex audit #1, #2): the ratchet itself is tested, not trusted.
//   LOOP-3 (±): the base the ratchet is read from (CI: the base branch) — an existing ref yields its
//     ratchet and oracle IDs; a missing or broken ref stops the scoreboard (non-zero) before any
//     oracle runs, instead of comparing against nothing.
//   LOOP-4 (±): a ratcheted oracle is held to PASS. FAIL, PENDING, SKIP for a missing input, a
//     timeout, a removal are regressions; only RETIRED, an oracle another CI job runs (a job the
//     workflow really has), and, in --fast, an oracle never run before, are not. Every oracle that
//     names a CI job is run by that job in the workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBase, regressions, ciJobs, workflowText, jobOf, BaseError, DEFAULT_JOB } from "../../scripts/ratchet.mjs";
import { ORACLES } from "../registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── LOOP-3 ───────────────────────────────────────────────────────────────────────────────────
test("LOOP-3: an existing ref yields its ratchet and its oracle IDs, every locked ID among them", () => {
  const { ratchet, ids } = readBase("HEAD");
  assert.ok(ratchet.length >= 10, `${ratchet.length} locked`);
  assert.ok(ids.length >= ratchet.length);
  assert.deepEqual(ratchet.filter((id) => !ids.includes(id)), []);
  assert.deepEqual(readBase("HEAD").ratchet, JSON.parse(spawnSync("git", ["show", "HEAD:accept/ratchet.json"], { cwd: ROOT, encoding: "utf8" }).stdout).passed);
});

test("LOOP-3: a missing or broken base is refused, never read as an empty ratchet", () => {
  assert.throws(() => readBase("refs/heads/no-such-ref-ludion"), BaseError, "a ref that does not exist");
  const good = { "accept/ratchet.json": JSON.stringify({ passed: ["LOOP-1", "STD-2"] }), "accept/registry.mjs": '{ id: "LOOP-1" }, { id: "STD-2" }' };
  const at = (over) => (file) => { const v = { ...good, ...over }[file]; if (v === undefined) throw new Error("fatal: path does not exist"); return v; };
  assert.deepEqual(readBase("x", at({})), { ratchet: ["LOOP-1", "STD-2"], ids: ["LOOP-1", "STD-2"] }, "control: a well-formed base reads");
  for (const [over, why] of [
    [{ "accept/ratchet.json": undefined }, "no ratchet file"], [{ "accept/registry.mjs": undefined }, "no registry"],
    [{ "accept/ratchet.json": "{ not json" }, "a ratchet that is not JSON"], [{ "accept/ratchet.json": "{}" }, "no passed list"],
    [{ "accept/ratchet.json": '{"passed":"LOOP-1"}' }, "passed not a list"], [{ "accept/ratchet.json": '{"passed":[]}' }, "an empty ratchet"],
    [{ "accept/ratchet.json": '{"passed":["loop-1"]}' }, "not an oracle ID"], [{ "accept/registry.mjs": "export const ORACLES = [];" }, "a registry with no oracle"],
    [{ "accept/ratchet.json": '{"passed":["LOOP-1","GATE-99"]}' }, "a locked ID the registry does not have"],
  ]) assert.throws(() => readBase("x", at(over)), BaseError, why);
});

test("LOOP-3: the scoreboard stops (exit 2) on a base it cannot read, before running any oracle", () => {
  for (const ref of ["refs/heads/no-such-ref-ludion", "HEAD~999999"]) {
    const t = Date.now();
    // LUDION_NESTED_SCOREBOARD: a scoreboard started by an oracle never runs oracles itself (no recursion).
    const r = spawnSync(process.execPath, ["scripts/scoreboard.mjs", "--fast", "--quiet", "--base", ref], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, LUDION_NESTED_SCOREBOARD: "1" } });
    assert.equal(r.status, 2, `${ref}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /ratchet: cannot read accept\/ratchet\.json/);
    assert.ok(Date.now() - t < 20_000, "it stopped before running oracles");
  }
});

// ── LOOP-4 ───────────────────────────────────────────────────────────────────────────────────
test("LOOP-4: a ratcheted oracle is held to PASS — FAIL, PENDING, SKIP, a timeout or a removal is a regression", () => {
  const ids = ["AA-1", "BB-1", "CC-1"];
  const base = { ratchet: ids, ids, jobs: new Set(["loop", "preview"]) };
  const judge = (results, extra = {}) => regressions({ ...base, results, ...extra });
  assert.deepEqual(judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "RETIRED" }, "CC-1": { status: "ELSEWHERE", job: "preview" } }), [], "control: nothing regressed");
  for (const r of [{ status: "FAIL" }, { status: "PENDING" }, { status: "SKIP", human: ["CLOUDFLARE_API_TOKEN"] }, { status: "FAIL", detail: "timeout 300000ms" }, { status: "UNRUN" }, { status: "WHATEVER" }]) {
    const out = judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "PASS" }, "CC-1": r });
    assert.equal(out.length, 1, `${JSON.stringify(r)} must be a regression`);
    assert.match(out[0], /^CC-1 /);
  }
  assert.match(judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "PASS" } })[0], /CC-1 removed/);
  assert.match(judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "PASS" }, "CC-1": { status: "ELSEWHERE", job: "nightly" } })[0], /job "nightly", which no workflow step runs/);
  assert.deepEqual(judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "PASS" }, "CC-1": { status: "UNRUN" } }, { fast: true }), [], "--fast: never run before, nothing known");
  assert.deepEqual(judge({ "AA-1": { status: "PASS" }, "BB-1": { status: "PASS" }, "CC-1": { status: "SKIP" } }, { fast: true }).length, 1, "--fast does not excuse a SKIP");
  assert.match(regressions({ ratchet: [], results: {}, ids: ["AA-1"], baseIds: ["AA-1", "ZZ-9"] })[0], /ZZ-9 deleted from the registry/);
});

test("LOOP-4: every CI job an oracle names is run by the workflow, and the default job too", () => {
  const jobs = ciJobs(workflowText(ROOT));
  assert.ok(jobs.has(DEFAULT_JOB), `the workflow runs --job ${DEFAULT_JOB}`);
  const named = [...new Set(ORACLES.map(jobOf))];
  assert.deepEqual(named.filter((j) => !jobs.has(j)), [], "an oracle names a job no workflow step runs");
  // the parser bites: a job only named in a comment, or under another script, is not run
  assert.deepEqual([...ciJobs("# --job ghost\n      - run: node scripts/other.mjs --job ghost\n      - run: node scripts/scoreboard.mjs --base x --job real")], ["real"]);
});

test("LOOP-4: the scoreboard judges with exactly these functions (no second regression rule of its own)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/scoreboard.mjs"), "utf8");
  assert.match(src, /import \{[^}]*\breadBase\b[^}]*\bregressions\b[^}]*\} from "\.\/ratchet\.mjs"/, "scoreboard.mjs imports readBase and regressions from ratchet.mjs");
  assert.doesNotMatch(src, /regressions\.push\(/, "and does not keep its own list");
});

test("LOOP-4: no ratcheted oracle can SKIP for a missing input — the inputs it needs come with the job that runs it", () => {
  const locked = JSON.parse(fs.readFileSync(path.join(ROOT, "accept/ratchet.json"), "utf8")).passed;
  const needy = ORACLES.filter((o) => locked.includes(o.id) && o.needs?.length);
  assert.deepEqual(needy.map((o) => o.id), [], "a ratcheted oracle with `needs` would SKIP wherever the input is missing");
});
