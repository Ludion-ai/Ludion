// LOOP-2's judge, offline: what counts as a full CI run and how it is timed (accept/loop/ci-time.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeRun, latestPushRun, LIMIT_S } from "./ci-time.mjs";

const T0 = Date.parse("2026-10-03T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const job = (name, from, to, conclusion = "success") => ({ name, status: "completed", conclusion, started_at: at(from), completed_at: at(to) });
// The shape of a push run: four shards in parallel, the merge after them, the preview beside them,
// and the nightly jobs skipped.
const run = (over = {}) => [
  job("loop-shard (1/4)", 0, over.shard ?? 300), job("loop-shard (2/4)", 2, 200), job("loop-shard (3/4)", 1, 210), job("loop-shard (4/4)", 3, 190),
  job("loop", (over.shard ?? 300) + 5, (over.shard ?? 300) + 40), job("preview", 1, over.preview ?? 280),
  { name: "nightly-windows", status: "completed", conclusion: "skipped", started_at: at(0), completed_at: at(0) },
  { name: "nightly", status: "completed", conclusion: "skipped", started_at: null, completed_at: null },
];

test("LOOP-2: a green run is timed from the first job's start to the last job's finish, not the sum of the jobs", () => {
  const v = judgeRun(run());
  assert.equal(v.pass, true, v.detail);
  assert.equal(v.wallS, 340);
  assert.match(v.metric, /^5:40 first start → last finish over 6 jobs \(limit 10:00\); slowest loop-shard \(1\/4\) 5:00$/);
});

test("LOOP-2: over 10 minutes fails, exactly 10 minutes passes", () => {
  assert.equal(LIMIT_S, 600);
  assert.equal(judgeRun(run({ preview: 600 })).pass, true);
  const v = judgeRun(run({ preview: 601 }));
  assert.equal(v.pass, false);
  assert.match(v.detail, /took 10:01 \(limit 10:00\)/);
});

test("LOOP-2: a run with a red, cancelled or unfinished job is not a full run, however fast", () => {
  for (const c of ["failure", "cancelled", "timed_out"]) {
    const jobs = run(); jobs[5] = job("preview", 1, 12, c);
    const v = judgeRun(jobs);
    assert.equal(v.pass, false, c);
    assert.match(v.detail, new RegExp(`not green: preview ${c}`));
  }
  const jobs = run(); jobs[4] = { ...jobs[4], status: "in_progress", conclusion: null, completed_at: null };
  assert.match(judgeRun(jobs).detail, /not finished: loop/);
  assert.equal(judgeRun([]).pass, false);
  assert.equal(judgeRun(run().filter((j) => j.conclusion === "skipped")).pass, false, "only skipped jobs: nothing ran");
});

test("LOOP-2: it reads the latest completed push run on main, and the jobs of that run's latest attempt", async () => {
  const seen = [];
  const fake = async (url, { headers }) => {
    seen.push({ url, auth: headers.authorization });
    if (url.includes("/workflows/")) return { ok: true, json: async () => ({ workflow_runs: [{ id: 7, run_attempt: 2, head_sha: "abc1234def", created_at: at(0) }] }) };
    return { ok: true, json: async () => ({ jobs: run() }) };
  };
  const { run: r, jobs } = await latestPushRun({ repo: "o/r", token: "t0k", fetch: fake });
  assert.equal(r.id, 7);
  assert.equal(jobs.length, 8);
  assert.equal(seen[0].url, "https://api.github.com/repos/o/r/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=1");
  assert.equal(seen[1].url, "https://api.github.com/repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100");
  assert.ok(seen.every((s) => s.auth === "Bearer t0k"));
  await assert.rejects(latestPushRun({ repo: "o/r", token: undefined, fetch: async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) }) }), /no completed push run/);
  await assert.rejects(latestPushRun({ repo: "o/r", token: undefined, fetch: async () => ({ ok: false, status: 404 }) }), /GitHub API 404/);
});
