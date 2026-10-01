// LOOP-5 (~): a pair is the two sides of one property (MISSION.md §1.4; the human's rule after the
// Codex audit). A positive oracle's pair is a negative (or ±) oracle that declares the same
// `property`: the honest thing passes one side, a fake fails the other, about the same thing.
// GATE-4 (latency) paired with GATE-6 (SSRF) was not that. MISSION.md's ± and 対 columns say
// exactly what the registry says. A positive with no pair is allowed; the scoreboard shows it as
// unpaired (not yet trustworthy) once it passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORACLES } from "../registry.mjs";
import { pairProblems, catalogRows } from "../../scripts/ratchet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MISSION = fs.readFileSync(path.join(ROOT, "docs/MISSION.md"), "utf8");

test("LOOP-5: every pair is a − or ± oracle of the same property, and the catalog's ± and 対 columns agree with the registry", () => {
  assert.deepEqual(pairProblems(ORACLES, MISSION), []);
  const pairs = ORACLES.filter((o) => o.pair);
  assert.ok(pairs.length >= 10, `${pairs.length} pairs`);
  console.log(`# LOOP-5: ${pairs.length} pairs over ${new Set(pairs.map((o) => o.property)).size} properties; unpaired positives: ${ORACLES.filter((o) => o.kind === "+" && !o.pair).map((o) => o.id).join(", ") || "none"}`);
});

test("LOOP-5: the check bites — a pair across properties, onto a positive, onto nothing, from a negative, or a catalog that disagrees", () => {
  const ok = [{ id: "AA-1", kind: "+", pair: "AA-2", property: "x" }, { id: "AA-2", kind: "-", property: "x" }];
  const md = "| AA-1 | + | 1 | c | AA-2 |\n| AA-2 | − | 1 | c | |\n";
  assert.deepEqual(pairProblems(ok, md), [], "control");
  for (const [oracles, mission, why] of [
    [[{ ...ok[0], property: "latency" }, { ...ok[1], property: "ssrf" }], md, "across properties (GATE-4 → GATE-6)"],
    [[ok[0], { ...ok[1], kind: "+" }], "| AA-1 | + | 1 | c | AA-2 |\n| AA-2 | + | 1 | c | |\n", "onto a positive"],
    [[{ ...ok[0], pair: "AA-9" }, ok[1]], "| AA-1 | + | 1 | c | AA-9 |\n| AA-2 | − | 1 | c | |\n", "onto nothing"],
    [[{ ...ok[0], property: undefined }, { ...ok[1], property: undefined }], md, "no property declared"],
    [[ok[0], { ...ok[1], pair: "AA-1" }], "| AA-1 | + | 1 | c | AA-2 |\n| AA-2 | − | 1 | c | AA-1 |\n", "from a negative"],
    [ok, "| AA-1 | + | 1 | c | |\n| AA-2 | − | 1 | c | |\n", "the catalog drops the pair"],
    [ok, "| AA-1 | ± | 1 | c | AA-2 |\n| AA-2 | − | 1 | c | |\n", "the catalog's ± differs"],
  ]) assert.ok(pairProblems(oracles, mission).length > 0, why);
  assert.deepEqual(catalogRows("| ID | ± | L | 合格条件 | 対 |\n|---|---|---|---|---|\n| GATE-4 | + | 1 | p99 \\| 2ms | GATE-5 |\n").get("GATE-4"), { kind: "+", pair: "GATE-5" }, "an escaped pipe in a condition");
});
