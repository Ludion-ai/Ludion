// The npm publish set (PUB-1, PUB-2): what `npm publish` will send, in dependency order.
// A package is in the set only if a customer installs it; the order is the order to publish in
// (every internal dependency is published before its dependents). docs/PUBLISH.md follows it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SET = ["gate-core", "scan", "report", "diver", "ludion", "gate-node", "gate-next", "gate-workers"];

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

/** `npm pack --dry-run --json` for one package: the exact file list npm would publish. */
export function packList(dir) {
  const [info] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], path.join(ROOT, "packages", dir)));
  return { name: info.name, version: info.version, files: info.files.map((f) => f.path.replace(/\\/g, "/")) };
}

/** Pack every package in the set into `dest`; returns the tarball paths in publish order. */
export function packAll(dest = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pub-"))) {
  return SET.map((dir) => {
    const [info] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dest], path.join(ROOT, "packages", dir)));
    return path.join(dest, info.filename);
  });
}
