// The sharded scoreboard may not lose, duplicate or mix up an oracle (scripts/shard.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FORMAT, parseShard, assignShards, mergeShards } from "../shard.mjs";

const ORACLES = [
  { id: "A-1", run: () => {} }, { id: "B-1", run: () => {}, exclusive: true }, { id: "C-1" },
  { id: "D-1", run: () => {} }, { id: "E-1", run: () => {}, exclusive: true }, { id: "F-1", run: () => {} },
];
const W = { "A-1": 20_000, "B-1": 30_000, "D-1": 1_000, "E-1": 10_000, "F-1": 8_000 };

test("shard: i/n is parsed strictly", () => {
  assert.deepEqual(parseShard("2/3"), { i: 2, n: 3 });
  for (const bad of ["0/3", "4/3", "1", "a/b", "", undefined]) assert.throws(() => parseShard(bad));
});

test("shard: every oracle gets exactly one shard, deterministically, balanced by weight", () => {
  const a = assignShards(ORACLES, 3, W), b = assignShards([...ORACLES], 3, { ...W });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ORACLES.map((o) => o.id).sort());
  for (const s of Object.values(a)) assert.ok(s >= 1 && s <= 3);
  assert.notEqual(a["B-1"], a["A-1"], "the two heaviest go to different shards");
  const one = assignShards(ORACLES, 1, W);
  assert.ok(Object.values(one).every((s) => s === 1));
});

function shardFiles(assign, n, { sha = "abc", fingerprint = "fp", drop = [], dup, mutate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-shard-test-"));
  const files = [];
  for (let i = 1; i <= n; i++) {
    if (drop.includes(i)) continue;
    const ids = ORACLES.filter((o) => assign[o.id] === i).map((o) => o.id);
    if (dup && i === dup.into) ids.push(dup.id);
    const s = { format: FORMAT, sha, fingerprint, shard: { i, n }, ids, results: Object.fromEntries(ids.map((id) => [id, { status: "PASS" }])) };
    mutate?.(s);
    const f = path.join(dir, `s${i}.json`);
    fs.writeFileSync(f, JSON.stringify(s));
    files.push(f);
  }
  return files;
}

test("shard: the judge (base) holds the PR's shards to each other and to every base oracle; oracles the PR added are allowed", () => {
  const a = assignShards(ORACLES, 3, W);
  const base = ORACLES.filter((o) => o.id !== "F-1"); // the base registry before the PR added F-1
  const ok = mergeShards(shardFiles(a, 3, { sha: "prsha", fingerprint: "pr" }), { oracles: base, sha: "prsha", judge: true });
  assert.deepEqual(ok.problems, [], "another verifier than the judge's own is fine: the shards agree with each other");
  assert.deepEqual(ok.extra, ["F-1"]);
  assert.ok(mergeShards(shardFiles(a, 3, { sha: "prsha", mutate: (s) => { if (s.shard.i === 2) s.sha = "other"; } }), { oracles: base, judge: true })
    .problems.some((p) => /different commits/.test(p)));
  assert.ok(mergeShards(shardFiles(a, 3, { sha: "prsha" }), { oracles: base, sha: "expected", judge: true }).problems.some((p) => /expected expected/.test(p)));
  assert.ok(mergeShards(shardFiles(a, 3, { mutate: (s) => { if (s.shard.i === 1) s.fingerprint = "x"; } }), { oracles: base, judge: true })
    .problems.some((p) => /different verifiers/.test(p)));
  const dropped = mergeShards(shardFiles(a, 3, { mutate: (s) => { s.ids = s.ids.filter((id) => id !== "A-1"); delete s.results["A-1"]; } }), { oracles: base, judge: true });
  assert.ok(dropped.problems.some((p) => p.includes("A-1 ran in no shard")), "a base oracle the PR's run lacks is caught");
  const twice = mergeShards(shardFiles(a, 3, { mutate: (s) => { if (!s.ids.includes("F-1")) { s.ids.push("F-1"); s.results["F-1"] = { status: "PASS" }; } } }), { oracles: base, judge: true });
  assert.ok(twice.problems.some((p) => p.includes("F-1 ran in")), "an added oracle in two shards is caught too");
});

test("shard: a clean merge returns every result and no problem", () => {
  const a = assignShards(ORACLES, 3, W);
  const m = mergeShards(shardFiles(a, 3), { oracles: ORACLES, sha: "abc", print: "fp" });
  assert.deepEqual(m.problems, []);
  assert.deepEqual(Object.keys(m.results).sort(), ORACLES.map((o) => o.id).sort());
});

test("shard: a missing shard, a duplicate, another commit or another verifier is a problem, never a pass", () => {
  const a = assignShards(ORACLES, 3, W);
  const lost = mergeShards(shardFiles(a, 3, { drop: [2] }), { oracles: ORACLES, sha: "abc", print: "fp" });
  assert.ok(lost.problems.some((p) => /shard 2\/3 is missing/.test(p)));
  for (const o of ORACLES.filter((x) => a[x.id] === 2)) assert.equal(lost.results[o.id].status, "FAIL");

  const other = ORACLES.find((o) => a[o.id] === 1).id;
  const dup = mergeShards(shardFiles(a, 3, { dup: { id: other, into: 2 } }), { oracles: ORACLES, sha: "abc", print: "fp" });
  assert.ok(dup.problems.some((p) => p.includes(`${other} ran in 2 shards`)));
  assert.equal(dup.results[other].status, "FAIL");

  assert.ok(mergeShards(shardFiles(a, 3, { sha: "zzz" }), { oracles: ORACLES, sha: "abc", print: "fp" }).problems.some((p) => /ran zzz/.test(p)));
  assert.ok(mergeShards(shardFiles(a, 3, { fingerprint: "other" }), { oracles: ORACLES, sha: "abc", print: "fp" }).problems.some((p) => /different verifier/.test(p)));

  const noResult = mergeShards(shardFiles(a, 3, { mutate: (s) => { if (s.shard.i === 1) s.results = {}; } }), { oracles: ORACLES, sha: "abc", print: "fp" });
  assert.ok(noResult.problems.some((p) => /has no result/.test(p)));
  assert.ok(mergeShards([], { oracles: ORACLES, sha: "abc", print: "fp" }).problems.includes("merge: no shard files"));
});
