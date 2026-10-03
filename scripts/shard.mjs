// Sharding for the scoreboard (LOOP-2): split one CI job's oracles over n parallel CI jobs, then
// merge the shard results back into one scoreboard. Each shard runs its oracles one at a time, as
// a full run does, so an oracle with a latency or Lighthouse threshold never shares its machine.
// The merge is where nothing may fall through the cracks: every oracle of the job must come back
// exactly once, from shards that ran the same commit and the same verifier.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const FORMAT = "ludion-scoreboard-shard/1";

/** "2/3" → { i: 2, n: 3 } */
export function parseShard(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s ?? ""));
  if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`--shard must be i/n with 1 ≤ i ≤ n (got ${JSON.stringify(s)})`);
  return { i: +m[1], n: +m[2] };
}

/**
 * Deterministic assignment id → shard (1..n): longest first on the recorded time, ties by registry
 * order, each to the least-loaded shard (ties: lowest index). An oracle without `run` costs nothing.
 * Weights only balance the load; correctness never depends on them (the merge checks coverage).
 */
export function assignShards(oracles, n, weights = {}) {
  const cost = (o) => (o.run ? (weights[o.id] ?? 5_000) : 0);
  const order = oracles.map((o, idx) => ({ o, idx, c: cost(o) })).sort((a, b) => b.c - a.c || a.idx - b.idx);
  const load = Array(n).fill(0), out = {};
  for (const { o, c } of order) {
    let best = 0;
    for (let k = 1; k < n; k++) if (load[k] < load[best]) best = k;
    load[best] += c;
    out[o.id] = best + 1;
  }
  return out;
}

/** What the shards must agree on: the verifier itself (registry, catalog, scoreboard, ratchet, sharding). */
export const VERIFIER_FILES = ["accept/registry.mjs", "docs/MISSION.md", "scripts/scoreboard.mjs", "scripts/shard.mjs", "scripts/ratchet.mjs", "scripts/shard-weights.json"];
export function fingerprint(root) {
  const h = createHash("sha256");
  for (const f of VERIFIER_FILES) {
    const p = path.join(root, f);
    h.update(`${f}\n`).update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0)).update("\n");
  }
  return h.digest("hex");
}

/**
 * Merge shard files into one result set for `oracles` (the job's oracles). Anything inconsistent is
 * a problem (the scoreboard turns problems into regressions, so the merged run fails) and the
 * affected oracles become FAIL: a missing or doubled shard, shards of another n, another commit
 * (`sha`) or another verifier (`print`), an oracle in no shard or in two, an oracle that is not the
 * job's, an oracle assigned but without a result.
 * @returns {{ results: Record<string, object>, problems: string[], shards: object[] }}
 */
export function mergeShards(files, { oracles, sha, print, job }) {
  const problems = [], shards = [];
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { problems.push(`merge: cannot read ${f}: ${e.message}`); continue; }
    if (s?.format !== FORMAT) { problems.push(`merge: ${f} is not a scoreboard shard (${s?.format})`); continue; }
    shards.push({ ...s, file: f });
  }
  if (!shards.length) problems.push("merge: no shard files");
  const ns = [...new Set(shards.map((s) => s.shard?.n))];
  if (ns.length > 1) problems.push(`merge: shards disagree on n (${ns.join(", ")})`);
  const n = ns[0] ?? 0;
  for (let i = 1; i <= n; i++) {
    const c = shards.filter((s) => s.shard?.i === i).length;
    if (c === 0) problems.push(`merge: shard ${i}/${n} is missing`);
    if (c > 1) problems.push(`merge: shard ${i}/${n} appears ${c} times`);
  }
  for (const s of shards) {
    const at = `shard ${s.shard?.i}/${s.shard?.n}`;
    if (sha && s.sha !== sha) problems.push(`merge: ${at} ran ${s.sha}, this is ${sha}`);
    if (print && s.fingerprint !== print) problems.push(`merge: ${at} ran a different verifier (registry/scoreboard fingerprint)`);
    if (job !== undefined && s.job !== job) problems.push(`merge: ${at} ran job ${JSON.stringify(s.job)}, this is ${JSON.stringify(job)}`);
  }
  const results = {};
  for (const o of oracles) {
    const holders = shards.filter((s) => (s.ids ?? []).includes(o.id));
    if (holders.length === 0) { results[o.id] = { status: "FAIL", detail: "merge: in no shard" }; problems.push(`merge: ${o.id} ran in no shard`); continue; }
    if (holders.length > 1) { results[o.id] = { status: "FAIL", detail: `merge: in ${holders.length} shards` }; problems.push(`merge: ${o.id} ran in ${holders.length} shards`); continue; }
    const r = holders[0].results?.[o.id];
    if (!r?.status) { results[o.id] = { status: "FAIL", detail: "merge: assigned but no result" }; problems.push(`merge: ${o.id} has no result`); continue; }
    results[o.id] = r;
  }
  const known = new Set(oracles.map((o) => o.id));
  for (const s of shards) for (const id of s.ids ?? []) if (!known.has(id)) problems.push(`merge: shard ${s.shard?.i}/${s.shard?.n} ran ${id}, which is not this job's`);
  return { results, problems, shards };
}

/** shard-weights.json's `ms` from shard files (what CI really took per oracle), for rebalancing. */
export function weightsFrom(files) {
  const ms = {};
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [id, r] of Object.entries(s.results ?? {})) if (r.ms != null) ms[id] = r.ms;
  }
  return Object.fromEntries(Object.entries(ms).sort(([a], [b]) => a.localeCompare(b)));
}

export const WEIGHTS_NOTE = "ms per oracle in a real CI shard run (node scripts/shard.mjs --weights shard-*.json), only to balance the shards. Correctness never depends on it: the merge checks every oracle ran exactly once.";

// node scripts/shard.mjs --weights shards/*.json  → print a new shard-weights.json from a CI run
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--weights");
  if (i < 0) { console.error("usage: node scripts/shard.mjs --weights <shard.json>…"); process.exit(2); }
  console.log(JSON.stringify({ note: WEIGHTS_NOTE, ms: weightsFrom(process.argv.slice(i + 1)) }, null, 1));
}
