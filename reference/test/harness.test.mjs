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
