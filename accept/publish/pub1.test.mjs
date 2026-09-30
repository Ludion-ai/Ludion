// PUB-1 (+, pair PUB-2): the npm publish set installs from its tarballs alone into a clean project
// (fresh dir, fresh npm cache, no workspace) and works: the `ludion` CLI (bin linked, scan equal to
// the repo's, init + sign, report), and my agent → my Gate → VERIFIED through gate-node, gate-workers
// and gate-next. Third-party dependencies come from the npm registry, as they will for a customer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, SET, packAll, npm, manifest } from "./set.mjs";

let tmp, app, cli;
const run = (args, opts = {}) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...opts });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pub1-"));
  fs.mkdirSync(path.join(tmp, "tgz"));
  const tarballs = packAll(path.join(tmp, "tgz"));
  app = path.join(tmp, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "pub1-clean-app", private: true, type: "module" }));
  npm(["install", ...tarballs, "--no-package-lock", "--cache", path.join(tmp, "npm-cache"), "--prefer-online"], app, { timeout: 600_000 });
  cli = path.join(app, "node_modules", "ludion", "bin", "ludion.mjs");
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("PUB-1: every package of the set is installed from its tarball, at its version, and nothing from the monorepo leaks in", () => {
  for (const dir of SET) {
    const m = manifest(dir);
    const got = JSON.parse(fs.readFileSync(path.join(app, "node_modules", ...m.name.split("/"), "package.json"), "utf8"));
    assert.equal(got.version, m.version, `${m.name} installed at its version`);
    const real = fs.realpathSync(path.join(app, "node_modules", ...m.name.split("/")));
    assert.ok(!real.startsWith(fs.realpathSync(ROOT)), `${m.name} is a copy in the clean app, not a link into the repo`);
  }
  const bin = path.join(app, "node_modules", ".bin", process.platform === "win32" ? "ludion.cmd" : "ludion");
  assert.ok(fs.existsSync(bin), "`ludion` is linked into node_modules/.bin (what `npx ludion` runs)");
});

test("PUB-1: `ludion scan` from the clean install prints exactly what the repo's CLI prints", () => {
  const log = path.join(ROOT, "accept", "fixtures", "logs", "corpus", "nginx-access.log");
  const clean = JSON.parse(run(["scan", log, "--json"], { cwd: app }));
  const repo = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "packages", "diver", "bin", "ludion.mjs"), "scan", log, "--json"], { encoding: "utf8", cwd: ROOT }));
  assert.deepEqual(clean, repo);
  assert.ok(clean && typeof clean === "object", "scan printed JSON");
});

test("PUB-1: `ludion init --dev` then `ludion sign` produce a Web Bot Auth signature", () => {
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(agent);
  run(["init", "--dev", "--name", "PUB-1 Agent", "--contact", "mailto:ops@example.test"], { cwd: agent });
  assert.ok(fs.existsSync(path.join(agent, "ludion.json")), "init wrote ludion.json");
  const out = run(["sign", "GET", "https://shop.example/products"], { cwd: agent });
  assert.match(out, /signature-input/i);
  assert.match(out, /signature-agent/i);
  assert.match(out, /tag="web-bot-auth"/);
});

test("PUB-1: `ludion report` from the clean install renders exactly the repo's daily report", () => {
  const events = path.join(ROOT, "accept", "fixtures", "report", "events", "gate-events.ndjson");
  const args = ["report", "--events", events, "--site", "site-7f3a9c2e", "--date", "2026-09-29", "--tz", "Asia/Tokyo", "--lang", "ja", "--format", "text"];
  const clean = run(args, { cwd: app });
  const repo = execFileSync(process.execPath, [path.join(ROOT, "packages", "diver", "bin", "ludion.mjs"), ...args], { encoding: "utf8", cwd: ROOT });
  assert.ok(clean.length > 200, "a report was printed");
  assert.equal(clean, repo);
});

test("PUB-1: my agent → my Gate → VERIFIED, through gate-node, gate-workers and gate-next, importing only published names", () => {
  fs.copyFileSync(path.join(ROOT, "accept", "publish", "flow.mjs"), path.join(app, "flow.mjs"));
  const out = execFileSync(process.execPath, ["flow.mjs"], { cwd: app, encoding: "utf8", timeout: 120_000 });
  const oks = out.split("\n").filter((l) => l.startsWith("ok "));
  assert.ok(out.includes("ok flow complete"), out);
  console.log(`# PUB-1: ${SET.length} packages from tarballs; ${oks.length} flow checks`);
});
