#!/usr/bin/env node
// Build the site once per content hash, outside the tree, so parallel scoreboards never share a dist.
//   node site/build.mjs            → prints the dist directory (built or cached)
//   node site/build.mjs --out DIR  → builds into DIR
// The site is its own npm project (not a root workspace: Astro would slow every `npm ci`).
// Its node_modules is installed in place, from its lockfile, only when the lockfile changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SITE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".astro", "test", "preview.json"]); // preview.json records a deploy; it is not part of what was built
// Code outside site/ that the build bundles (astro.config.mjs aliases it): /scan runs the CLI's scan.
const BUNDLED = ["packages/scan/src", "packages/gate-core/src/agents.mjs", "packages/gate-core/src/route.mjs"];
const ENV = { ASTRO_TELEMETRY_DISABLED: "1", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };

/** The npm CLI as a JS file, so no .cmd shim or shell is needed on Windows. */
function npmCli() {
  const c = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const hit = c.find((p) => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
  if (!hit) throw new Error("npm-cli.js not found next to node");
  return hit;
}
const run = (args, opts = {}) => execFileSync(process.execPath, args, { cwd: SITE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000, maxBuffer: 64e6, env: { ...process.env, ...ENV }, ...opts });

function files(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}
/** Content hash of everything the build reads (line endings normalised: the same tree on any OS). */
export function siteHash() {
  const h = createHash("sha256");
  const add = (name, file) => h.update(name).update("\0").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).update("\0");
  for (const f of files(SITE)) add(f, path.join(SITE, f));
  const root = path.dirname(SITE);
  for (const b of BUNDLED) {
    const abs = path.join(root, b);
    if (fs.statSync(abs).isDirectory()) for (const f of files(abs)) add(`${b}/${f}`, path.join(abs, f));
    else add(b, abs);
  }
  return h.digest("hex").slice(0, 16);
}

/** Serialise installs and builds across processes with a lock directory. */
function withLock(dir, fn) {
  const lock = `${dir}.lock`;
  const until = Date.now() + 600_000;
  for (;;) {
    try { fs.mkdirSync(lock, { recursive: false }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - fs.statSync(lock).mtimeMs > 900_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > until) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** Install an npm project in place from its lockfile (the site, or its edge Worker in site/edge). */
export function ensureDeps(dir = SITE) {
  const lockHash = createHash("sha256").update(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const marker = path.join(dir, "node_modules", ".ludion-lock");
  const ok = () => fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === lockHash;
  if (ok()) return;
  withLock(path.join(dir, "node_modules"), () => {
    if (ok()) return;
    run([npmCli(), "ci", "--no-audit", "--no-fund"], { cwd: dir });
    fs.writeFileSync(marker, lockHash);
  });
}

// Astro renames files from site/.astro into its output directory, which fails across devices
// (EXDEV: the Windows runner has the checkout on D: and the temp dir on C:). So Astro writes only
// inside site/, and the finished output is moved out: a rename, or a copy when that cannot cross.

/** Where Astro builds for a given destination: inside site/, on its device. */
export function stageDir(dist) {
  const tag = createHash("sha256").update(path.resolve(dist)).digest("hex").slice(0, 12);
  return path.join(SITE, ".astro", "out", `${tag}-${process.pid}`);
}

// Windows refuses to rename a directory while another process (the antivirus, the indexer) holds a
// file in it open; the files can still be read and copied.
const COPY_INSTEAD = new Set(["EXDEV", "EPERM", "EBUSY", "EACCES"]);

/** Move a directory tree to `to` (replacing it); copy and delete when a rename cannot cross devices or the tree is held. */
export function moveDir(from, to, { rename = fs.renameSync } = {}) {
  fs.rmSync(to, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { rename(from, to); }
  catch (e) {
    if (!COPY_INSTEAD.has(e.code)) throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Build (or reuse) the static site; returns the dist directory. */
export function buildSite({ out } = {}) {
  ensureDeps();
  const dist = out ?? path.join(os.tmpdir(), "ludion-site", siteHash());
  const done = path.join(dist, ".ludion-built");
  if (!out && fs.existsSync(done)) return dist;
  fs.mkdirSync(path.dirname(dist), { recursive: true });
  return withLock(dist, () => {
    if (!out && fs.existsSync(done)) return dist;
    const stage = stageDir(dist);
    fs.rmSync(stage, { recursive: true, force: true });
    try {
      run([path.join(SITE, "node_modules", "astro", "bin", "astro.mjs"), "build", "--outDir", stage]);
      // The build's identity, served as a static file: WEB-1 compares the preview's with this checkout's.
      fs.writeFileSync(path.join(stage, "_build.json"), JSON.stringify({ site: siteHash() }) + "\n");
      fs.writeFileSync(path.join(stage, ".ludion-built"), new Date().toISOString());
      moveDir(stage, dist);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    return dist;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  try { console.log(buildSite({ out: i > 0 ? path.resolve(process.argv[i + 1]) : undefined })); }
  catch (e) { console.error(`${e.stdout ?? ""}${e.stderr ?? ""}` || e.message); process.exit(1); }
}
