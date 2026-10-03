// The npm publish set (PUB-1..4): what `npm publish` will send. A package is in the set only if a
// customer installs it. docs/PUBLISH.md follows it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// ADR-036: npm gets one package, `ludion`; the CLI's and the Gate's packages travel inside it (BUNDLED,
// copied into its tarball at prepack) and are private in the repository.
export const SET = ["ludion"];
export { VENDORED as BUNDLED } from "../../packages/ludion/vendored.mjs";

/** The npm CLI as a JS file (no .cmd shim on Windows). */
export function npmCli() {
  const beside = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(beside)) return beside;
  const prefix = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["prefix", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  for (const p of [path.join(prefix, "node_modules", "npm", "bin", "npm-cli.js"), path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js")]) if (fs.existsSync(p)) return p;
  throw new Error("npm-cli.js not found");
}

export function npm(args, cwd, { env = {}, timeout = 300_000 } = {}) {
  return execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 64e6,
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...env } });
}

export const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8"));

/**
 * Run one package's pack the way `npm publish` does: its prepack script, the pack, its postpack
 * script (ludion vendors the CLI's code at prepack and removes it at postpack). Other lifecycle
 * scripts stay off (--ignore-scripts on the pack itself).
 */
function withLifecycle(dir, pack) {
  const cwd = path.join(ROOT, "packages", dir);
  npm(["run", "prepack", "--if-present"], cwd);
  try { return pack(cwd); } finally { npm(["run", "postpack", "--if-present"], cwd); }
}

/** `npm pack --dry-run --json` for one package: the exact file list npm would publish. */
export function packList(dir) {
  const [info] = withLifecycle(dir, (cwd) => JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], cwd)));
  return { name: info.name, version: info.version, files: info.files.map((f) => f.path.replace(/\\/g, "/")) };
}

/** Pack one package of the set into `dest`; returns the tarball path. */
export function packOne(dir, dest = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pub-"))) {
  const [info] = withLifecycle(dir, (cwd) => JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dest], cwd)));
  return path.join(dest, info.filename);
}

/** Pack every package in the set into `dest`; returns the tarball paths in publish order. */
export function packAll(dest = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pub-"))) {
  return SET.map((dir) => packOne(dir, dest));
}
