// Sharding for the scoreboard: split the oracles over n CI jobs, then merge the shard results back
// into one scoreboard. The merge is where nothing may fall through the cracks: every registry ID
// must come back exactly once, from shards that ran the same commit and the same verifier.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const FORMAT = "ludion-scoreboard-shard/1";

/** "2/3" → { i: 2, n: 3 } */
export function parseShard(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s ?? ""));
  if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`--shard must be i/n with 1 ≤ i ≤ n (got ${JSON.stringify(s)})`);
  return { i: +m[1], n: +m[2] };
}

/**
 * Deterministic assignment id → shard (1..n): longest-processing-time first on an estimated cost,
 * ties by registry order, then the least-loaded shard (ties: lowest index). Exclusive oracles run
 * serially in their shard, so they cost their full time; shared ones overlap, so they cost half.
 * Weights only balance the load; correctness never depends on them (the merge checks coverage).
 */
export function assignShards(oracles, n, weights = {}) {
  const cost = (o) => (!o.run ? 0 : (weights[o.id] ?? 5_000) * (o.exclusive ? 1 : 0.5));
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

/** What the shards must agree on: the verifier itself (registry, catalog, scoreboard, sharding). */
export function fingerprint(root) {
  const h = createHash("sha256");
  for (const f of ["accept/registry.mjs", "docs/MISSION.md", "scripts/scoreboard.mjs", "scripts/shard.mjs", "scripts/ratchet.mjs", "scripts/ci-timing.mjs", "scripts/proc.mjs", "scripts/shard-weights.json"]) {
    const p = path.join(root, f);
    h.update(`${f}\n`).update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));
  }
  return h.digest("hex");
}

/**
 * Merge shard files into one result set. Anything inconsistent becomes a problem (the caller turns
 * problems into regressions, so the merged run fails) and the affected IDs become FAIL.
 *
 * Normal merge (the PR's own scoreboard): every shard ran this checkout's commit (`sha`) and this
 * verifier (`print`), and ran exactly this registry's oracles.
 * Judge merge (`judge: true`, the base branch's scoreboard judging a PR's shards): the shards must
 * agree with each other on commit and verifier (and on `sha` when given), and every oracle of the
 * judge's own registry (the base's) must come back exactly once; oracles the PR added are allowed.
 * @returns {{ results: Record<string, object>, problems: string[], shards: object[], extra: string[] }}
 */
export function mergeShards(files, { oracles, sha, print, judge = false }) {
  const problems = [], shards = [];
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { problems.push(`merge: cannot read ${f}: ${e.message}`); continue; }
    if (s.format !== FORMAT) { problems.push(`merge: ${f} is not a scoreboard shard (${s.format})`); continue; }
    shards.push({ ...s, file: f });
  }
  const ns = [...new Set(shards.map((s) => s.shard?.n))];
  if (!shards.length) problems.push("merge: no shard files");
  if (ns.length > 1) problems.push(`merge: shards disagree on n (${ns.join(", ")})`);
  const n = ns[0] ?? 0;
  const seen = shards.map((s) => s.shard?.i);
  for (let i = 1; i <= n; i++) {
    const c = seen.filter((x) => x === i).length;
    if (c === 0) problems.push(`merge: shard ${i}/${n} is missing`);
    if (c > 1) problems.push(`merge: shard ${i}/${n} appears ${c} times`);
  }
  if (judge) {
    // The judge's own files are the base's, so the shards are held to each other instead.
    const shas = [...new Set(shards.map((s) => s.sha))], prints = [...new Set(shards.map((s) => s.fingerprint))];
    if (shas.length > 1) problems.push(`merge: shards ran different commits (${shas.join(", ")})`);
    if (sha && shas.some((x) => x !== sha)) problems.push(`merge: shards ran ${shas.join(", ")}, expected ${sha}`);
    if (prints.length > 1) problems.push("merge: shards ran different verifiers (registry/scoreboard fingerprint)");
  } else for (const s of shards) {
    if (sha && s.sha !== sha) problems.push(`merge: shard ${s.shard.i}/${s.shard.n} ran ${s.sha}, this is ${sha}`);
    if (print && s.fingerprint !== print) problems.push(`merge: shard ${s.shard.i}/${s.shard.n} ran a different verifier (registry/scoreboard fingerprint)`);
  }
  const results = {};
  for (const o of oracles) {
    const holders = shards.filter((s) => (s.ids ?? []).includes(o.id));
    if (holders.length === 0) { results[o.id] = { status: "FAIL", detail: "merge: in no shard" }; problems.push(`merge: ${o.id} ran in no shard`); continue; }
    if (holders.length > 1) { results[o.id] = { status: "FAIL", detail: `merge: in ${holders.length} shards` }; problems.push(`merge: ${o.id} ran in ${holders.length} shards`); continue; }
    const r = holders[0].results?.[o.id];
    if (!r) { results[o.id] = { status: "FAIL", detail: "merge: assigned but no result" }; problems.push(`merge: ${o.id} has no result`); continue; }
    results[o.id] = r;
  }
  const known = new Set(oracles.map((o) => o.id)), extra = [];
  for (const s of shards) for (const id of s.ids ?? []) {
    if (known.has(id)) continue;
    if (!judge) { problems.push(`merge: shard ${s.shard.i}/${s.shard.n} ran unknown oracle ${id}`); continue; }
    // Judge: an oracle the PR added. Allowed, but it must still be in exactly one shard.
    if (!extra.includes(id)) extra.push(id);
    const c = shards.filter((x) => (x.ids ?? []).includes(id)).length;
    if (c > 1 && !problems.includes(`merge: ${id} ran in ${c} shards`)) problems.push(`merge: ${id} ran in ${c} shards`);
  }
  return { results, problems, shards, extra };
}
