// PUB-3 (+, pair PUB-2): `ludion` alone. The CLI goes to npm first, before any @ludion/* package
// (the human's order, 2026-10-01: @ludion/gate-* waits). So its tarball must install into a clean
// project (fresh dir, fresh npm cache, no workspace) with every @ludion/* fetch going to a registry
// that refuses: nothing @ludion may be needed from npm. Then the CLI works as the repo's does: the
// bin is linked, scan and report print exactly the repo CLI's output, init + sign make a Web Bot
// Auth signature. Third-party dependencies come from the npm registry, as they will for a customer.
// The tarball is made the way `npm publish` makes it: prepack, pack, postpack.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { ROOT, npm, packOne } from "./set.mjs";

let tmp, app, cli, tarball;
const run = (args, opts = {}) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...opts });
const repoCli = (args) => execFileSync(process.execPath, [path.join(ROOT, "packages", "diver", "bin", "ludion.mjs"), ...args], { encoding: "utf8", cwd: ROOT });

/** A local port nobody listens on: the @ludion registry for this install. */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pub3-"));
  fs.mkdirSync(path.join(tmp, "tgz"));
  tarball = packOne("ludion", path.join(tmp, "tgz"));
  app = path.join(tmp, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "pub3-clean-app", private: true, type: "module" }));
  const nowhere = `http://127.0.0.1:${await closedPort()}/`;
  npm(["install", tarball, "--no-package-lock", "--cache", path.join(tmp, "npm-cache"), "--prefer-online", `--@ludion:registry=${nowhere}`, "--fetch-retries=0"], app, { timeout: 600_000 });
  cli = path.join(app, "node_modules", "ludion", "bin", "ludion.mjs");
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("PUB-3: the ludion tarball alone installs with no @ludion/* package on npm, and needs none", () => {
  const m = JSON.parse(fs.readFileSync(path.join(app, "node_modules", "ludion", "package.json"), "utf8"));
  assert.deepEqual(Object.keys({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies }).filter((d) => d.startsWith("@ludion/") || d === "ludion"), [],
    "the published manifest names no @ludion package");
  assert.ok(!fs.existsSync(path.join(app, "node_modules", "@ludion")), "nothing @ludion was installed beside it");
  const bin = path.join(app, "node_modules", ".bin", process.platform === "win32" ? "ludion.cmd" : "ludion");
  assert.ok(fs.existsSync(bin), "`ludion` is linked into node_modules/.bin (what `npx ludion` runs)");
  const real = fs.realpathSync(path.join(app, "node_modules", "ludion"));
  assert.ok(!real.startsWith(fs.realpathSync(ROOT)), "a copy in the clean app, not a link into the repo");
});

test("PUB-3: `ludion scan` from the lone tarball prints exactly what the repo's CLI prints", () => {
  const log = path.join(ROOT, "accept", "fixtures", "logs", "corpus", "nginx-access.log");
  assert.deepEqual(JSON.parse(run(["scan", log, "--json"], { cwd: app })), JSON.parse(repoCli(["scan", log, "--json"])));
});

test("PUB-3: `ludion report` from the lone tarball renders exactly the repo's daily report", () => {
  const events = path.join(ROOT, "accept", "fixtures", "report", "events", "gate-events.ndjson");
  const args = ["report", "--events", events, "--site", "site-7f3a9c2e", "--date", "2026-09-29", "--tz", "Asia/Tokyo", "--lang", "en", "--format", "text"];
  const out = run(args, { cwd: app });
  assert.ok(out.length > 200, "a report was printed");
  assert.equal(out, repoCli(args));
});

test("PUB-3: `ludion init --dev` then `ludion sign` from the lone tarball produce a Web Bot Auth signature", () => {
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(agent);
  run(["init", "--dev", "--name", "PUB-3 Agent", "--contact", "mailto:ops@example.test"], { cwd: agent });
  assert.ok(fs.existsSync(path.join(agent, "ludion.json")), "init wrote ludion.json");
  const out = run(["sign", "GET", "https://shop.example/products"], { cwd: agent });
  assert.match(out, /signature-input/i);
  assert.match(out, /signature-agent/i);
  assert.match(out, /tag="web-bot-auth"/);
});
