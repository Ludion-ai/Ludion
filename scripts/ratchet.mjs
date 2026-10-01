// The ratchet's judgement, apart from running oracles, so the verifier itself can be tested
// (LOOP-3, LOOP-4; Codex audit #1 and #2). scoreboard.mjs uses exactly these.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const ORACLE_ID = /^[A-Z]{2,5}-\d+$/;
const REGISTRY_IDS = /\bid:\s*"([A-Z]{2,5}-\d+)"/g;

export class BaseError extends Error {
  constructor(message) { super(message); this.name = "BaseError"; }
}

/**
 * The ratchet and the oracle IDs as they are on `ref` (CI: the base branch). A base that cannot be
 * read, or reads as nonsense, throws: comparing against nothing would pass everything (LOOP-3).
 * @param {string} ref
 * @param {(file: string) => string} [show] reads a file at the ref (tests inject one)
 * @returns {{ ratchet: string[], ids: string[] }}
 */
export function readBase(ref, show = (file) => execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64e6 })) {
  const read = (file) => {
    try { return show(file); } catch (e) { throw new BaseError(`cannot read ${file} at ${ref}: ${String(e?.stderr || e?.message || e).trim().split("\n")[0]}`); }
  };
  let parsed;
  try { parsed = JSON.parse(read("accept/ratchet.json")); } catch (e) { throw e instanceof BaseError ? e : new BaseError(`accept/ratchet.json at ${ref} is not JSON`); }
  const ratchet = parsed?.passed;
  if (!Array.isArray(ratchet) || !ratchet.length || !ratchet.every((id) => typeof id === "string" && ORACLE_ID.test(id))) {
    throw new BaseError(`accept/ratchet.json at ${ref} has no list of oracle IDs in "passed"`);
  }
  const ids = [...read("accept/registry.mjs").matchAll(REGISTRY_IDS)].map((m) => m[1]);
  if (!ids.length) throw new BaseError(`accept/registry.mjs at ${ref} declares no oracle`);
  const unknown = ratchet.filter((id) => !ids.includes(id));
  if (unknown.length) throw new BaseError(`accept/ratchet.json at ${ref} locks oracles its registry does not have: ${unknown.join(", ")}`);
  return { ratchet, ids };
}

/** The CI jobs that run the scoreboard, by their `--job <name>`, from a workflow file's text. */
export function ciJobs(workflowText) {
  return new Set([...String(workflowText).matchAll(/scoreboard\.mjs[^\n]*?--job[ =]"?([a-z0-9-]+)/g)].map((m) => m[1]));
}

export const DEFAULT_JOB = "loop";
export const jobOf = (oracle) => oracle.job ?? DEFAULT_JOB;

/**
 * What once passed and no longer does (LOOP-4): a ratcheted oracle is held to PASS. Anything else
 * is a regression — FAIL, PENDING, a SKIP for a missing input, a timeout — except:
 *   RETIRED    retired the way MISSION.md allows (its retireWhen all PASS);
 *   ELSEWHERE  another CI job runs it, and that job exists (`jobs`, from the workflow);
 *   UNRUN      in a --fast run, an oracle with no earlier full run to read (nothing is known).
 * Plus every ID the base registry has and this one does not.
 * @param {{ ratchet: string[], results: Record<string, { status: string, detail?: string, job?: string }>,
 *           ids: Set<string>|string[], baseIds?: string[], fast?: boolean, jobs?: Set<string>|null }} o
 * @returns {string[]}
 */
export function regressions({ ratchet, results, ids, baseIds = [], fast = false, jobs = null }) {
  const have = ids instanceof Set ? ids : new Set(ids);
  const out = [];
  for (const id of ratchet) {
    const r = results[id];
    if (!r) { out.push(`${id} removed`); continue; }
    if (r.status === "PASS" || r.status === "RETIRED") continue;
    if (r.status === "ELSEWHERE") {
      if (jobs && !jobs.has(r.job)) out.push(`${id} belongs to CI job "${r.job}", which no workflow step runs`);
      continue;
    }
    if (fast && r.status === "UNRUN") continue;
    out.push(`${id} ${r.status}${r.detail ? ` — ${r.detail}` : ""}${r.human ? ` (needs ${r.human.join(", ")})` : ""}`);
  }
  for (const id of baseIds) if (!have.has(id)) out.push(`${id} deleted from the registry`);
  return out;
}

/** The workflow file the CI runs (for `ciJobs`). */
export function workflowText(root) {
  const f = path.join(root, ".github", "workflows", "ci.yml");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

/**
 * MISSION.md §4's rows: ID → { kind, pair }, the kind as the registry writes it ("−" → "-").
 * Cells split on unescaped pipes; the pair is the last cell, whatever the condition holds.
 */
export function catalogRows(md) {
  const rows = new Map();
  for (const line of String(md).split("\n")) {
    const m = /^\|\s*([A-Z]{2,5}-\d+)\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    rows.set(m[1], { kind: cells[2].replace("−", "-"), pair: cells[cells.length - 2] });
  }
  return rows;
}

/**
 * A pair is the two sides of one property (LOOP-5): only a positive oracle has one, it names an
 * existing − or ± oracle, both declare the same `property`, and MISSION.md's ± and 対 columns say
 * what the registry says.
 * @returns {string[]} problems (empty: every pair holds)
 */
export function pairProblems(oracles, md) {
  const byId = new Map(oracles.map((o) => [o.id, o]));
  const rows = catalogRows(md);
  const out = [];
  for (const o of oracles) {
    if (o.pair) {
      const p = byId.get(o.pair);
      if (o.kind !== "+") out.push(`${o.id}: only a positive oracle has a pair (it is ${o.kind})`);
      if (!p) out.push(`${o.id}: its pair ${o.pair} does not exist`);
      else {
        if (p.kind !== "-" && p.kind !== "±") out.push(`${o.id}: its pair ${p.id} is ${p.kind}, not a negative`);
        if (!o.property || o.property !== p.property) out.push(`${o.id} (${o.property ?? "no property"}) and its pair ${p.id} (${p.property ?? "no property"}) are not one property`);
      }
    }
    const row = rows.get(o.id);
    if (row) {
      if (row.kind !== o.kind) out.push(`${o.id}: MISSION.md says ${row.kind}, the registry ${o.kind}`);
      if (row.pair !== (o.pair ?? "")) out.push(`${o.id}: MISSION.md pairs it with "${row.pair}", the registry with "${o.pair ?? ""}"`);
    }
  }
  return out;
}
