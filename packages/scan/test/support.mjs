// Shared by the SCAN-1..3 suites: the corpus, its ground truth, a CLI runner, and the checks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../../..");
export const FIXTURES = path.join(ROOT, "accept/fixtures/logs");
export const CORPUS = path.join(FIXTURES, "corpus");
export const CLI = path.join(ROOT, "packages/diver/bin/ludion.mjs");
const TRAP = pathToFileURL(path.join(HERE, "no-network.mjs")).href;

/** Every truth file, sorted by fixture name. */
export function truths() {
  const dir = path.join(FIXTURES, "truth");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".truth.json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

/**
 * Run `ludion scan …` in a child process with every network/subprocess API trapped.
 * @returns {{ code: number, stdout: string, stderr: string, net: string[] }}
 */
export function runScan(args, { input } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludion-scan3-")), "net.log");
  fs.writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", TRAP, CLI, "scan", ...args], {
    cwd: ROOT, encoding: "utf8", input, env: { ...process.env, LUDION_NET_TRAP: log }, maxBuffer: 64e6, timeout: 120_000,
  });
  const net = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", net };
}

const V4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const V6 = /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![0-9a-f:])/gi;

/**
 * Everything in `out` that must never leave a scan: IP addresses (any), and every canary the
 * corpus planted (IPs, query values, identifier path segments, cookies, users, referers).
 * @returns {string[]} what leaked, empty when clean
 */
export function leaks(out, canaries) {
  const found = [];
  for (const m of out.matchAll(V4)) found.push(`ipv4 ${m[0]}`);
  for (const m of out.matchAll(V6)) found.push(`ipv6 ${m[0]}`);
  for (const [kind, values] of Object.entries(canaries)) {
    for (const v of values) if (v.length >= 4 && out.includes(v)) found.push(`${kind} ${v}`);
  }
  return found;
}

/** All canaries of all fixtures, merged. */
export function allCanaries(ts = truths()) {
  const c = {};
  for (const t of ts) for (const [k, vs] of Object.entries(t.canaries)) { c[k] ??= new Set(); for (const v of vs) c[k].add(v); }
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [...v]]));
}

/** A route template: every segment a placeholder or a plain word (spec §11.7). */
const SEGMENT = /^(?::(?:id|uuid|email|handle|hex|token|param)|\*\*|[._]?[A-Za-z][A-Za-z_-]{0,31}(?:\.[A-Za-z0-9]{1,8})?|v\d{1,3})?$/;
export function untemplated(route) {
  if (!route.startsWith("/") || /[?#%@\s]/.test(route)) return true;
  return route.slice(1).split("/").some((s) => !SEGMENT.test(s));
}

/** Sum the per-file expectations into one. */
export function sumExpect(ts) {
  const add = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === "number") a[k] = (a[k] ?? 0) + v;
      else a[k] = add(a[k] ?? {}, v);
    }
    return a;
  };
  return ts.reduce((acc, t) => add(acc, t.expect), {});
}
