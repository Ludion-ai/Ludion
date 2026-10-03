// LOOP-4, sharded: CI splits the `loop` job's oracles over parallel jobs (LOOP-2) and merges them back
// (scripts/shard.mjs). The ratchet holds only if the merge cannot lose, double or mix up an oracle:
// every oracle of the job comes back exactly once, from shards of this commit and this verifier,
// and anything else fails the merged run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORMAT, parseShard, assignShards, mergeShards, fingerprint, VERIFIER_FILES } from "../../scripts/shard.mjs";
import { jobOf } from "../../scripts/ratchet.mjs";
import { ORACLES as REAL } from "../registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORACLES = [
  { id: "A-1", run: () => {} }, { id: "B-1", run: () => {} }, { id: "C-1" },
  { id: "D-1", run: () => {} }, { id: "E-1", run: () => {} }, { id: "F-1", run: () => {} },
];
const W = { "A-1": 20_000, "B-1": 30_000, "D-1": 1_000, "E-1": 10_000, "F-1": 8_000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludion-shard-test-"));

function shardFiles(oracles, assign, n, { sha = "abc", fingerprint = "fp", job = "loop", drop = [], dup, mutate } = {}) {
  const dir = tmp(), files = [];
  for (let i = 1; i <= n; i++) {
    if (drop.includes(i)) continue;
    const ids = oracles.filter((o) => assign[o.id] === i).map((o) => o.id);
    if (dup && i === dup.into) ids.push(dup.id);
    const s = { format: FORMAT, sha, fingerprint, job, shard: { i, n }, ids, results: Object.fromEntries(ids.map((id) => [id, { status: "PASS", ms: 1 }])) };
    mutate?.(s);
    const f = path.join(dir, `shard-${i}.json`);
    fs.writeFileSync(f, JSON.stringify(s));
    files.push(f);
  }
  return files;
}
const opts = { oracles: ORACLES, sha: "abc", print: "fp", job: "loop" };

test("LOOP-4: shards — i/n is parsed strictly", () => {
  assert.deepEqual(parseShard("2/3"), { i: 2, n: 3 });
  for (const bad of ["0/3", "4/3", "1", "a/b", "", undefined, "1/0"]) assert.throws(() => parseShard(bad), String(bad));
});

test("LOOP-4: shards — every oracle gets exactly one shard, deterministically, the heaviest apart", () => {
  const a = assignShards(ORACLES, 3, W);
  assert.deepEqual(a, assignShards([...ORACLES], 3, { ...W }));
  assert.deepEqual(Object.keys(a).sort(), ORACLES.map((o) => o.id).sort());
  for (const s of Object.values(a)) assert.ok(s >= 1 && s <= 3);
  assert.notEqual(a["B-1"], a["A-1"], "the two heaviest go to different shards");
  assert.ok(Object.values(assignShards(ORACLES, 1, W)).every((s) => s === 1));
});

test("LOOP-4: shards — a clean merge returns every result and no problem", () => {
  const a = assignShards(ORACLES, 3, W);
  const m = mergeShards(shardFiles(ORACLES, a, 3), opts);
  assert.deepEqual(m.problems, []);
  assert.deepEqual(Object.keys(m.results).sort(), ORACLES.map((o) => o.id).sort());
  assert.ok(Object.values(m.results).every((r) => r.status === "PASS"));
});

test("LOOP-4: shards — a lost, doubled or foreign shard, another commit, verifier or job is a problem and a FAIL, never a pass", () => {
  const a = assignShards(ORACLES, 3, W);
  const lost = mergeShards(shardFiles(ORACLES, a, 3, { drop: [2] }), opts);
  assert.ok(lost.problems.some((p) => /shard 2\/3 is missing/.test(p)));
  for (const o of ORACLES.filter((x) => a[x.id] === 2)) assert.equal(lost.results[o.id].status, "FAIL", o.id);

  const other = ORACLES.find((o) => a[o.id] === 1).id;
  const dup = mergeShards(shardFiles(ORACLES, a, 3, { dup: { id: other, into: 2 } }), opts);
  assert.ok(dup.problems.some((p) => p.includes(`${other} ran in 2 shards`)));
  assert.equal(dup.results[other].status, "FAIL");

  const twice = shardFiles(ORACLES, a, 3);
  assert.ok(mergeShards([...twice, twice[0]], opts).problems.some((p) => /shard 1\/3 appears 2 times/.test(p)));
  assert.ok(mergeShards(shardFiles(ORACLES, a, 3, { mutate: (s) => { if (s.shard.i === 3) s.shard.n = 4; } }), opts).problems.some((p) => /disagree on n/.test(p)));
  assert.ok(mergeShards(shardFiles(ORACLES, a, 3, { sha: "zzz" }), opts).problems.some((p) => /ran zzz, this is abc/.test(p)));
  assert.ok(mergeShards(shardFiles(ORACLES, a, 3, { fingerprint: "other" }), opts).problems.some((p) => /different verifier/.test(p)));
  assert.ok(mergeShards(shardFiles(ORACLES, a, 3, { job: "preview" }), opts).problems.some((p) => /ran job "preview"/.test(p)));
  const foreign = mergeShards(shardFiles(ORACLES, a, 3, { mutate: (s) => { if (s.shard.i === 1) { s.ids.push("Z-9"); s.results["Z-9"] = { status: "PASS" }; } } }), opts);
  assert.ok(foreign.problems.some((p) => /ran Z-9, which is not this job's/.test(p)));

  const noResult = mergeShards(shardFiles(ORACLES, a, 3, { mutate: (s) => { if (s.shard.i === 1) s.results = {}; } }), opts);
  assert.ok(noResult.problems.some((p) => /has no result/.test(p)));
  const notShard = path.join(tmp(), "x.json");
  fs.writeFileSync(notShard, JSON.stringify({ passed: [] }));
  assert.ok(mergeShards([notShard], opts).problems.some((p) => /not a scoreboard shard/.test(p)));
  assert.ok(mergeShards([], opts).problems.includes("merge: no shard files"));
});

test("LOOP-4: shards — the verifier fingerprint covers the registry, the catalog, the scoreboard, the ratchet and the sharding", () => {
  for (const f of ["accept/registry.mjs", "docs/MISSION.md", "scripts/scoreboard.mjs", "scripts/ratchet.mjs", "scripts/shard.mjs", "scripts/shard-weights.json"]) {
    assert.ok(VERIFIER_FILES.includes(f), f);
  }
  assert.match(fingerprint(ROOT), /^[0-9a-f]{64}$/);
});

// The real scoreboard merging shard files of the real registry: what CI's `loop` job does.
function scoreboard(args) {
  return spawnSync(process.execPath, ["scripts/scoreboard.mjs", "--base", "HEAD", "--job", "loop", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, LUDION_NESTED_SCOREBOARD: "1" },
  });
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();

test("LOOP-4: shards — the scoreboard's --merge passes complete shards of this commit, and fails a lost oracle or a lost shard", () => {
  const job = REAL.filter((o) => jobOf(o) === "loop");
  const a = assignShards(job, 4, {});
  const good = shardFiles(job, a, 4, { sha: head, fingerprint: fingerprint(ROOT) });
  const ok = scoreboard(["--merge", ...good, "--quiet"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  const victim = job.find((o) => o.run).id;
  const lostOracle = shardFiles(job, a, 4, { sha: head, fingerprint: fingerprint(ROOT), mutate: (s) => { s.ids = s.ids.filter((id) => id !== victim); delete s.results[victim]; } });
  const r1 = scoreboard(["--merge", ...lostOracle, "--quiet"]);
  assert.equal(r1.status, 1, "an oracle in no shard fails the run");
  assert.match(r1.stdout, new RegExp(`REGRESSION merge: ${victim} ran in no shard`));

  const r2 = scoreboard(["--merge", ...good.slice(1), "--quiet"]);
  assert.equal(r2.status, 1, "a shard that never arrived fails the run");
  assert.match(r2.stdout, /REGRESSION merge: shard 1\/4 is missing/);

  const r3 = scoreboard(["--merge", ...shardFiles(job, a, 4, { sha: "0".repeat(40), fingerprint: fingerprint(ROOT) }), "--quiet"]);
  assert.equal(r3.status, 1, "shards of another commit fail the run");
});

test("LOOP-4: shards — a shard needs --out, and neither --shard nor --merge updates the ratchet", () => {
  for (const args of [["--shard", "1/2"], ["--shard", "3/2", "--out", "x.json"], ["--shard", "1/2", "--out", "x.json", "--update-ratchet"], ["--merge", "x.json", "--update-ratchet"], ["--merge", "x.json", "--fast"]]) {
    const r = spawnSync(process.execPath, ["scripts/scoreboard.mjs", ...args], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, LUDION_NESTED_SCOREBOARD: "1" } });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
});
