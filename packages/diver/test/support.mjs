// Shared by the DIV-3 / DIV-4 suites: run the real `ludion` CLI in a sandbox where cwd, HOME and
// every temp dir live under one directory, so "everything the CLI wrote" is exactly that tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { base32 } from "../src/index.mjs";

export const CLI = fileURLToPath(new URL("../bin/ludion.mjs", import.meta.url));
export const PASSPHRASE = "div3 correct horse battery staple";
export const DIRECTORY_FILE = path.join(".well-known", "http-message-signatures-directory");

export function sandbox(prefix = "ludion-div-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const d = { root, cwd: path.join(root, "work"), home: path.join(root, "home"), tmp: path.join(root, "tmp") };
  for (const p of [d.cwd, d.home, d.tmp]) fs.mkdirSync(p);
  const outputs = [];
  /** Run the CLI. stdin is a pipe (never a TTY), the passphrase only when given. */
  function run(args, { env = {} } = {}) {
    const base = { ...process.env };
    for (const k of ["LUDION_ROOT_PASSPHRASE", "LUDION_DEV"]) delete base[k];
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: d.cwd, encoding: "utf8", input: "",
      env: { ...base, HOME: d.home, USERPROFILE: d.home, APPDATA: path.join(d.home, "AppData"), LOCALAPPDATA: path.join(d.home, "Local"),
        XDG_CONFIG_HOME: path.join(d.home, ".config"), TMPDIR: d.tmp, TEMP: d.tmp, TMP: d.tmp, ...env },
    });
    outputs.push({ args, stdout: r.stdout, stderr: r.stderr });
    return r;
  }
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(d.cwd, rel), "utf8"));
  const files = () => filesUnder(root);
  return { ...d, run, outputs, read, files, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function filesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out); else out.push(p);
  }
  return out;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Every encoding a 32-byte Ed25519 seed (JWK `d`) could be written in. */
export function seedEncodings(d) {
  const seed = Buffer.from(d, "base64url");
  if (seed.length !== 32) throw new Error("not an Ed25519 seed");
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const b64 = seed.toString("base64");
  return {
    "JWK d (base64url)": d,
    "base64": b64,
    "base64 unpadded": b64.replace(/=+$/, ""),
    "hex": seed.toString("hex"),
    "HEX": seed.toString("hex").toUpperCase(),
    "base32": base32(seed),
    "raw bytes": seed,
    "PKCS#8 DER": pkcs8,
    "PKCS#8 base64 (PEM body)": pkcs8.toString("base64"),
    "PKCS#8 base64url": pkcs8.toString("base64url"),
    "PKCS#8 hex": pkcs8.toString("hex"),
  };
}

/** [{ where, encoding }] for every needle found in any of the blobs. */
export function findEncodings(blobs, needles) {
  const hits = [];
  for (const { where, bytes } of blobs) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
    for (const [encoding, needle] of Object.entries(needles)) {
      if (buf.indexOf(Buffer.isBuffer(needle) ? needle : Buffer.from(needle, "utf8")) >= 0) hits.push({ where, encoding });
    }
  }
  return hits;
}
