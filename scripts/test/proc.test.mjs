// A hung oracle costs its cap, not the CI run: the scoreboard kills the whole process tree it
// started and reports "timeout after Ns" with the last output — never "no test matched". The hang
// here is the real one (#32, #41): a grandchild inherits the pipes and keeps them open.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../proc.mjs";

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A child that prints, starts a grandchild holding the same stdout/stderr, and never exits.
const HANGER = `const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
console.log("still here, grandchild " + g.pid); setInterval(() => {}, 1000);`;

test("proc: run() kills the whole tree on timeout and says so", async () => {
  const t = Date.now();
  const r = await run(process.execPath, ["-e", HANGER], { cwd: os.tmpdir(), timeout: 1500 });
  assert.ok(Date.now() - t < 20_000, "it returned: the inherited pipes did not keep it waiting");
  assert.equal(r.timedOut, true);
  const pid = Number(/grandchild (\d+)/.exec(r.out)?.[1]);
  assert.ok(pid > 0, r.out);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(alive(pid), false, "the grandchild is dead too");
});

test("proc: an oracle over its cap is FAIL 'timeout after Ns' with its last output, and its tree is killed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-proc-test-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "accept"), { recursive: true });
  for (const f of fs.readdirSync(SCRIPTS).filter((n) => /\.(mjs|json)$/.test(n))) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, "scripts", f));
  // CHECK-1 runs right after HANG-1 in the same scoreboard process (--jobs 1: registry order), so it
  // sees whether the tree died at the cap. (Exit alone would not tell: Windows kills a dead parent's
  // children anyway.)
  fs.writeFileSync(path.join(dir, "accept/registry.mjs"), `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/proc.mjs";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let seen = "";
export const ORACLES = [
  { id: "HANG-1", m: "M0", kind: "~", level: 1, title: "hangs", timeoutMs: 2000,
    run: async () => { const r = run(process.execPath, ["hanger.cjs"], { cwd: ROOT, timeout: 600000 }); await r; return { pass: true }; } },
  { id: "CHECK-1", m: "M0", kind: "~", level: 1, title: "the hung tree is gone while the scoreboard still runs",
    run: async () => { await new Promise((r) => setTimeout(r, 700)); const pid = Number(fs.readFileSync(path.join(ROOT, "gpid"), "utf8"));
      return { pass: !alive(pid), detail: alive(pid) ? "grandchild " + pid + " still alive" : undefined }; } },
];
`);
  fs.writeFileSync(path.join(dir, "hanger.cjs"), HANGER.replace("console.log(", 'require("node:fs").writeFileSync("gpid", String(g.pid)); console.log('));
  const t = Date.now();
  const r = spawnSync(process.execPath, ["scripts/scoreboard.mjs", "--jobs", "1"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  assert.ok(Date.now() - t < 30_000, "the scoreboard came back near the 2 s cap, not after the child's 10 min");
  const line = r.stdout.split("\n").find((l) => l.includes("HANG-1")) ?? "";
  assert.match(line, /^FAIL/);
  assert.match(line, /timeout after 2s \(process tree killed\); last output: still here, grandchild \d+/);
  assert.doesNotMatch(line, /no test matched/);
  assert.match(r.stdout, /^PASS\s+CHECK-1/m, "the grandchild died at the cap, while the scoreboard was still running");
});
