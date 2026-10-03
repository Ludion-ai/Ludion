// SCAN-6 (−, the pair of SCAN-4, property scan-throughput): SCAN-4's speed cannot be had without the
// work. Its bench (packages/scan/bench/scan4.mjs) times a CLI over generated logs; here it times
// planted CLIs on a small file and must fail each: one that counts half the lines, one that counts
// without classifying, one slower than the limit, one with no report, one that exits non-zero. The
// real CLI passes the same small bench (the control), so a failure means the plant, not the setup.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCH = path.join(ROOT, "packages/scan/bench/scan4.mjs");
const REAL = path.join(ROOT, "packages/diver/bin/ludion.mjs");
const BYTES = 2_000_000, LIMIT_S = 4;

/** A planted CLI: runs the real one, then bends its report or its exit the way `bend` says. */
function plant(dir, name, bend) {
  const f = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(f, `import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [${JSON.stringify(REAL)}, ...process.argv.slice(2)], { encoding: "utf8", maxBuffer: 64e6 });
const rep = JSON.parse(r.stdout);
${bend}
`);
  return f;
}
function bench(cli) {
  const r = spawnSync(process.execPath, [BENCH, "--bytes", String(BYTES), "--limit-s", String(LIMIT_S), ...(cli ? ["--cli", cli] : [])], { encoding: "utf8", timeout: 120_000 });
  let res = null;
  try { res = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* no result line */ }
  return { code: r.status, res, out: r.stdout + r.stderr };
}

test("SCAN-6: the bench fails every CLI that is fast without doing the work, and passes the real one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-scan6-"));
  try {
    const control = bench();
    assert.equal(control.code, 0, `control: the real CLI on ${BYTES} bytes — ${control.out.slice(-400)}`);
    assert.equal(control.res?.pass, true);
    const plants = [
      ["counts half the lines", "rep.totals.records = Math.floor(rep.totals.records / 2); rep.totals.parsed = Math.floor(rep.totals.parsed / 2); console.log(JSON.stringify(rep));", /records \d+ ≠ \d+ written/],
      ["counts without classifying", "rep.classes = { UNKNOWN: rep.totals.records, DECLARED: 0, SUSPECTED: 0 }; console.log(JSON.stringify(rep));", /DECLARED 0 ≠ \d+/],
      ["is slower than the limit", `console.log(JSON.stringify(rep)); await new Promise((ok) => setTimeout(ok, ${(LIMIT_S + 1) * 1000}));`, new RegExp(`s > ${LIMIT_S}s`)],
      ["prints no report", "console.log('scanned');", /no JSON report/],
      ["exits non-zero", "console.log(JSON.stringify(rep)); process.exit(3);", /scan exited 3/],
    ];
    const caught = [];
    for (const [what, bend, why] of plants) {
      const r = bench(plant(dir, what.replace(/\W+/g, "-"), bend));
      assert.notEqual(r.code, 0, `${what}: the bench passed it`);
      assert.equal(r.res?.pass, false, what);
      assert.ok(r.res.problems.some((p) => why.test(p)), `${what}: ${JSON.stringify(r.res.problems)}`);
      caught.push(what);
    }
    console.log(`SCAN-6: ${caught.length}/${plants.length} planted CLIs failed the bench (control: the real CLI passed, ${control.res.seconds}s for ${BYTES} bytes)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
