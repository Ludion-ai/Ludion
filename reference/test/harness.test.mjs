// The reference harness itself (fast, no app installs). GATE-1 hung for 30 min in CI (#41) and
// GATE-3 on Windows (#32): a server outlived its test, its pipes kept `node --test` alive, and the
// scoreboard read the kill as "no test matched". These pin the three ways that happened.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { freePorts, start, stopAll, liveChildren } from "../harness.mjs";

after(stopAll);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return cond(); };

test("GATE-1: harness: ports handed out in one Promise.all are distinct, even across calls", async () => {
  const batches = await Promise.all([freePorts(8), freePorts(8), freePorts(8)]);
  const all = batches.flat();
  assert.equal(new Set(all).size, all.length, `duplicate port in ${all}`);
});

test("GATE-1: harness: a start that never becomes ready leaves no child and no grandchild behind", async () => {
  // The stub prints a grandchild's pid, and neither of them ever answers HTTP.
  const script = `const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "inherit" });
    console.log("grandchild " + g.pid); setInterval(() => {}, 1e9);`;
  const [port] = await freePorts(1);
  const before = liveChildren();
  let log = "";
  const t0 = Date.now();
  await assert.rejects(start("stub", os.tmpdir(), port, { env: { LUDION_STUB_SCRIPT: script }, readyTimeoutMs: 1500 })
    .catch((e) => { log = e.message; throw e; }), /not ready/);
  assert.ok(Date.now() - t0 < 25_000, "a failed start returns promptly");
  assert.equal(liveChildren(), before, "the half-started server was stopped");
  const pid = Number(/grandchild (\d+)/.exec(log)?.[1]);
  if (pid) assert.ok(await until(() => !alive(pid), 10_000), `grandchild ${pid} was killed with its tree`);
});

test("GATE-1: harness: stop() returns in bounded time and releases the pipes", async () => {
  const [port] = await freePorts(1);
  const script = `process.on("SIGTERM", () => {}); require("node:http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1"); setInterval(() => {}, 1e9);`;
  const s = await start("stub", os.tmpdir(), port, { env: { LUDION_STUB_SCRIPT: script }, readyTimeoutMs: 20_000 });
  const t0 = Date.now();
  await s.stop();
  assert.ok(Date.now() - t0 < 20_000, "stop() is bounded");
  assert.ok(s.child.stdout.destroyed && s.child.stderr.destroyed, "our ends of the pipes are closed");
  assert.ok(await until(() => !alive(s.child.pid), 10_000), "the server is gone");
});

// GATE-1 failed every run (2026-10-02) on a cache prepare() called ready: GATE-3 rebuilds the
// shared Next.js install's .next inside its clock, was stopped half way, and left no production
// build behind. A prepared install is used only when it is still whole.
test("GATE-1: harness: a prepared install is whole only with its build (a half-rebuilt .next is not)", async () => {
  const { intact } = await import("../harness.mjs");
  const fs = await import("node:fs"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-intact-"));
  try {
    const dirs = { A: path.join(root, "A"), B: path.join(root, "B") };
    for (const d of Object.values(dirs)) fs.mkdirSync(path.join(d, ".next"), { recursive: true });
    assert.equal(intact("next", dirs), false, "no BUILD_ID anywhere");
    fs.writeFileSync(path.join(dirs.A, ".next", "BUILD_ID"), "x");
    assert.equal(intact("next", dirs), false, "B lost its build (GATE-3 stopped half way)");
    fs.writeFileSync(path.join(dirs.B, ".next", "BUILD_ID"), "x");
    assert.equal(intact("next", dirs), true, "both builds present");
    assert.equal(intact("express", { A: path.join(root, "none"), B: path.join(root, "none") }), true, "an app without a build step has nothing to lose");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
