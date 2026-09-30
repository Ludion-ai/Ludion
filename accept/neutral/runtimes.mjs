#!/usr/bin/env node
// NEUT-1 (docs/MISSION.md §4): gate-core and Card Host pass the same suite on ≥2 independent
// runtimes. Here: Node, Deno and workerd — every one required, none skippable.
//
// The suite is packages/gate-core/test/portable/suite.mjs, byte for byte the same file on every
// runtime. It runs against the PACKED packages (npm pack of @ludion/gate-core and
// @ludion/card-host), installed in the OS temp dir next to the pinned runtimes of
// accept/neutral/runtime/ (deno and wrangler → workerd, exact versions, own lockfile):
//   node    node suite/cli.mjs
//   deno    deno run --no-prompt suite/cli.mjs      (no permissions at all: no net, no read, no env)
//   workerd wrangler dev (local workerd, nothing deployed), GET /run on suite/worker.mjs
// Each must report the exact list of tests the suite registers, in order, all passing. Zero tests,
// a missing runtime, another runtime answering, or a different list is a FAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npm, pack, freePort, start } from "../../reference/harness.mjs";
import { registeredTests, test as register } from "../../packages/gate-core/test/portable/shim.mjs";
import "../../packages/gate-core/test/portable/suite.mjs";
import { registerConformance } from "../../packages/gate-core/test/portable/conformance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RUNTIME = path.join(HERE, "runtime");
const PORTABLE = path.join(ROOT, "packages/gate-core/test/portable");
const SUITE_FILES = ["shim.mjs", "suite.mjs", "conformance.mjs", "cli.mjs", "worker.mjs"];
// The conformance vectors (GATE-10) run after the suite, in the hosts' order, from the same file.
const VECTORS = path.join(ROOT, "accept/conformance/vectors.json");
registerConformance(JSON.parse(fs.readFileSync(VECTORS, "utf8")), { test: register });
const PINNED = { deno: "2.9.6", wrangler: "4.144.0" };
const EXPECTED = registeredTests().map((t) => t.name);

const problems = [];
const ok = (msg) => console.log(`ok ${msg}`);

/** The runtimes, installed once per lockfile and platform (cached), then the packed packages on top. */
function prepare() {
  const h = createHash("sha256").update(`${process.platform}|${process.arch}|${process.version}\n`);
  for (const f of ["package.json", "package-lock.json"]) h.update(fs.readFileSync(path.join(RUNTIME, f)));
  const dir = path.join(os.tmpdir(), "ludion-neutral", h.digest("hex").slice(0, 16));
  if (!fs.existsSync(path.join(dir, ".ready"))) {
    fs.rmSync(path.join(os.tmpdir(), "ludion-neutral"), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(RUNTIME, f), path.join(dir, f));
    npm(["ci", "--no-audit", "--no-fund"], dir);
    fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  }
  const tmpPack = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-neutral-pack-"));
  const tarballs = pack(["gate-core", "card-host"], tmpPack);
  npm(["install", "--no-save", "--no-audit", "--no-fund", ...tarballs], dir);
  fs.rmSync(tmpPack, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "suite"), { recursive: true });
  for (const f of SUITE_FILES) fs.copyFileSync(path.join(PORTABLE, f), path.join(dir, "suite", f));
  fs.copyFileSync(VECTORS, path.join(dir, "suite", "vectors.json"));
  fs.writeFileSync(path.join(dir, "wrangler.toml"), [
    'name = "ludion-neutral"', 'main = "suite/worker.mjs"', 'compatibility_date = "2026-09-01"', 'compatibility_flags = ["nodejs_compat"]', "",
  ].join("\n"));
  // The installed packages must be the packed ones, not links into the repo.
  for (const p of ["gate-core", "card-host"]) {
    const d = path.join(dir, "node_modules", "@ludion", p);
    if (!fs.existsSync(path.join(d, "package.json")) || fs.lstatSync(d).isSymbolicLink()) throw new Error(`@ludion/${p} is not a packed install in ${dir}`);
  }
  return dir;
}

function denoBinary(dir) {
  const plat = { win32: "win32", darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  const names = [`${plat}-${arch}`, `${plat}-${arch}-glibc`];
  for (const n of names) for (const exe of ["deno.exe", "deno"]) {
    const p = path.join(dir, "node_modules", "@deno", n, exe);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no Deno binary for ${process.platform}-${process.arch} under node_modules/@deno`);
}

const lastJson = (out) => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());

/** Check one runtime's report against the suite. */
function judge(expectRuntime, res, version) {
  const label = `${expectRuntime} ${version ?? res?.version ?? "?"}`;
  if (!res || typeof res !== "object") return problems.push(`${label}: no result`);
  if (res.runtime !== expectRuntime) return problems.push(`${label}: reported runtime ${JSON.stringify(res.runtime)}`);
  const names = (res.tests ?? []).map((t) => t.name);
  if (!names.length || res.total === 0) return problems.push(`${label}: zero tests ran`);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) return problems.push(`${label}: ran ${names.length} tests, not the suite's ${EXPECTED.length} (${names.filter((n) => !EXPECTED.includes(n)).concat(EXPECTED.filter((n) => !names.includes(n))).slice(0, 3).join("; ")})`);
  const failed = res.tests.filter((t) => !t.ok);
  if (failed.length) return problems.push(`${label}: ${failed.length}/${names.length} failed — ${failed.map((t) => `${t.name}: ${t.error?.split("\n")[0]}`).join(" | ").slice(0, 600)}`);
  ok(`${label}: ${names.length}/${EXPECTED.length} portable tests pass`);
}

if (EXPECTED.length < 10) problems.push(`the portable suite registers only ${EXPECTED.length} tests`);
let dir;
try { dir = prepare(); } catch (e) { problems.push(`prepare: ${String(e?.message ?? e).slice(0, 400)}`); }

if (dir) {
  const installed = (name) => JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version;
  for (const [name, v] of Object.entries(PINNED)) if (installed(name) !== v) problems.push(`${name} ${installed(name)} installed, ${v} pinned`);

  // Node
  try {
    const out = execFileSync(process.execPath, ["suite/cli.mjs"], { cwd: dir, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    judge("node", lastJson(out), process.versions.node);
  } catch (e) { problems.push(`node: ${String(e.stderr || e.message).slice(0, 400)}`); }

  // Deno, with no permissions: anything the suite (or the packages) tried to reach would throw.
  try {
    const out = execFileSync(denoBinary(dir), ["run", "--no-prompt", "suite/cli.mjs"], {
      cwd: dir, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1", DENO_DIR: path.join(dir, ".deno") },
    });
    judge("deno", lastJson(out), installed("deno"));
  } catch (e) { problems.push(`deno: ${String(e.stderr || e.stdout || e.message).slice(0, 600)}`); }

  // workerd, through wrangler dev (local only; nothing is deployed)
  let server;
  try {
    const port = await freePort();
    server = await start("workers", dir, port);
    const r = await fetch(`http://127.0.0.1:${port}/run`, { signal: AbortSignal.timeout(120_000) });
    judge("workerd", await r.json(), `${installed("workerd")} (wrangler ${installed("wrangler")})`);
  } catch (e) { problems.push(`workerd: ${String(e?.message ?? e).slice(0, 400)}${server ? `\n${server.log.slice(-800)}` : ""}`); }
  finally { await server?.stop(); }
}

for (const p of problems) console.log(`FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
