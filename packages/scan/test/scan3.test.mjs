// SCAN-3 (−): scan output carries no raw IP, no query value, no untemplated path, and the scan
// makes zero network calls. The corpus plants canaries in every place a leak could come from.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { truths, allCanaries, runScan, leaks, untemplated, CORPUS } from "./support.mjs";

const TRAP = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "no-network.mjs")).href;
const TS = truths();

test("SCAN-3: the leak checker and the network trap bite", () => {
  const canaries = { query_values: ["qvabcdefghij"], path_segments: ["4821337", "zelda"], ips: [] };
  const bad = [
    "top route /products/4821337", "client 198.18.3.4", "client 2001:db8:1f::5", "client 2001:0db8:0000:0000:0000:0000:0000:0001",
    "q=qvabcdefghij", "/users/zelda",
  ];
  for (const s of bad) assert.ok(leaks(s, canaries).length > 0, `checker missed: ${s}`);
  assert.deepEqual(leaks("PASS 1,234 at 2026-09-29 00:00 UTC  /products/:id  99.7%  2026-09-29T00:00:12.345Z", canaries), []);
  for (const r of ["/users/zelda?x=1", "/products/4821337", "/@zelda", "/a%20b", "/tok/abc123"]) assert.ok(untemplated(r), `grammar missed: ${r}`);
  for (const r of ["/", "/products/:id", "/wp-login.php", "/api/v1/items/:id", "/blog/:param", "/.well-known/:param", "/a/b/c/d/e/**"]) assert.equal(untemplated(r), false, r);

  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludion-trap-")), "net.log");
  fs.writeFileSync(log, "");
  const probes = [
    "await fetch('https://example.com')",
    "(await import('node:http')).get('http://example.com')",
    "(await import('node:https')).request('https://example.com')",
    "(await import('node:net')).connect(80, 'example.com')",
    "new (await import('node:net')).Socket().connect(80, 'example.com')",
    "(await import('node:dns')).lookup('example.com', () => {})",
    "await (await import('node:dns')).promises.lookup('example.com')",
    "(await import('node:dgram')).createSocket('udp4')",
    "(await import('node:child_process')).execSync('curl https://example.com')",
    "new WebSocket('wss://example.com')",
  ];
  for (const p of probes) {
    const r = spawnSync(process.execPath, ["--import", TRAP, "--input-type=module", "-e", `try { ${p}; } catch { process.exit(3); } process.exit(0);`],
      { encoding: "utf8", env: { ...process.env, LUDION_NET_TRAP: log }, timeout: 30_000 });
    assert.equal(r.status, 3, `trap did not stop: ${p} (${r.stderr})`);
  }
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.filter((l) => l.startsWith("attempt")).length, probes.length, lines.join(" | "));
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
});

function assertClean(label, r, canaries) {
  assert.ok(r.net.includes("armed"), `${label}: trap was not loaded`);
  assert.deepEqual(r.net.filter((l) => l !== "armed"), [], `${label}: network/subprocess attempts`);
  assert.equal(r.stderr, "", `${label}: stderr ${r.stderr}`);
  assert.deepEqual(leaks(r.stdout, canaries), [], `${label}: leaked`);
}

test("SCAN-3: text and JSON for the whole corpus: no IP, query value or identifier; zero network", () => {
  const canaries = allCanaries(TS);
  assert.ok(canaries.ips.length > 100 && canaries.query_values.length > 50 && canaries.path_segments.length > 100, "corpus must plant canaries");
  for (const args of [[CORPUS], [CORPUS, "--json"], [CORPUS, "--json", "--top", "10000"], [CORPUS, "--top", "10000"]]) {
    const r = runScan(args);
    assert.equal(r.code, 0, r.stderr);
    assertClean(args.join(" "), r, canaries);
  }
});

test("SCAN-3: every file on its own, text and JSON, stdin too", () => {
  for (const t of TS) {
    const file = path.join(CORPUS, t.file);
    for (const args of [[file, "--top", "10000"], [file, "--json", "--top", "10000"]]) {
      const r = runScan(args);
      assert.equal(r.code, 0, `${t.file}: ${r.stderr}`);
      assertClean(`${t.file} ${args.slice(1).join(" ")}`, r, t.canaries);
    }
  }
  const t = TS.find((x) => !x.gzip);
  const r = runScan(["-", "--json", "--top", "10000"], { input: fs.readFileSync(path.join(CORPUS, t.file)) });
  assert.equal(r.code, 0, r.stderr);
  assertClean("stdin", r, t.canaries);
});

test("SCAN-3: every route the scan prints is a template", () => {
  const r = runScan([CORPUS, "--json", "--top", "10000"]);
  const report = JSON.parse(r.stdout);
  assert.ok(report.routes.length >= 10, `routes listed: ${report.routes.length}`);
  const bad = report.routes.map((x) => x.route).filter(untemplated);
  assert.deepEqual(bad, []);
  // The report names files, never paths or the addresses some vendors put in file names.
  for (const f of report.files) assert.ok(!f.name.includes("/") && !f.name.includes("\\"), f.name);
  for (const t of TS) {
    const r1 = runScan([path.join(CORPUS, t.file), "--json", "--top", "10000"]);
    assert.deepEqual(JSON.parse(r1.stdout).routes.map((x) => x.route).filter(untemplated), [], t.file);
  }
});
