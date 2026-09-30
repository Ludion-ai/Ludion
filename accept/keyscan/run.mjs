#!/usr/bin/env node
// REG-4 runner (docs/MISSION.md §4): no private key material in git history, logs, or build artifacts.
//
//   history    every blob reachable from any ref (`git rev-list --all --objects`), gzip unpacked
//   worktree   tracked + untracked-but-not-ignored files (a leak is caught before it is committed)
//   logs       *.log, *.jsonl, *.ndjson, *.gz, .loop/**, SCOREBOARD.* in the working tree
//   artifacts  `npm pack` of every workspace package (the tarball's contents), and any dist/
//
// Detected: JWK private member `d` (JSON, escaped JSON, JS/YAML literals), PEM private keys of any
// kind (encrypted ones too), PKCS#8 / PKCS#1 DER in base64 or hex (Ed25519, X25519, Ed448, X448, EC,
// RSA), and a sealed Ludion Root keystore (encrypted, but never something to publish).
//
// The runner tests itself first: planted keys in a throwaway repo (committed, then deleted, so they
// live only in history), a throwaway npm package and a log file must all be caught, and a published
// test vector must be recognised by its thumbprint. Otherwise it FAILs before looking at the repo.
// Output never contains key material: location, kind and thumbprint only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Private keys published in standards on purpose. Allowed ONLY by the RFC 7638 thumbprint computed
// from the private key that was found, never by file, path or pattern. Keep this list short, and
// cite the document that publishes each one.
const PUBLIC_TEST_KEYS = new Map([
  // RFC 9421 Appendix B.1.4 "test-key-ed25519" (also the key of draft-ietf-webbotauth-httpsig-protocol-00 App. E).
  ["poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U", "RFC 9421 B.1.4 test-key-ed25519"],
]);
// The seed of that published key, used only by the self-test to prove the allowlist works.
const RFC9421_TEST_SEED_B64U = "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU";

const MAX = 1 << 30;
// DER is written as byte lists so this file never contains the text forms it searches for.
const der = (...xs) => Buffer.from(xs);
const ED25519_PKCS8 = der(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
// Private-key-only DER fragments (the matching public key structures differ in these bytes).
const DER_FRAGMENTS = [
  ["PKCS#8 Ed25519", der(0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)],
  ["PKCS#8 X25519", der(0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20)],
  ["PKCS#8 Ed448", der(0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x71, 0x04, 0x3b, 0x04, 0x39)],
  ["PKCS#8 X448", der(0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6f, 0x04, 0x3a, 0x04, 0x38)],
  ["PKCS#8 EC", der(0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01)],
  ["PKCS#8 RSA", der(0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00)],
];
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The base64 (and base64url) text a DER fragment always produces, at each of its 3 byte alignments. */
function base64Forms(frag) {
  const forms = [0, 1, 2].map((k) => {
    const bytes = Buffer.concat([Buffer.alloc(k), frag]);
    return bytes.subarray(0, Math.floor(bytes.length / 3) * 3).toString("base64").slice([0, 2, 3][k]);
  });
  return [...new Set(forms.flatMap((f) => [f, f.replace(/\+/g, "-").replace(/\//g, "_")]))];
}

/** RFC 7638 thumbprint of the Ed25519 key with this 32-byte seed (derived by OpenSSL), or undefined. */
function ed25519Thumbprint(seed) {
  if (seed?.length !== 32) return undefined;
  try {
    const x = createPublicKey(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
    return createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest("base64url");
  } catch { return undefined; }
}
const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const D_PATTERNS = [
  /"d"\s*:\s*"([A-Za-z0-9_-]{20,})"/g,                    // JSON
  /\\"d\\"\s*:\s*\\"([A-Za-z0-9_-]{20,})\\"/g,            // JSON inside a JSON string
  /(?<![\w$.])d\s*:\s*["'`]([A-Za-z0-9_-]{20,})["'`]/g,  // JS object literal
  /'d'\s*:\s*'([A-Za-z0-9_-]{20,})'/g,                    // single-quoted key
  /^\s*d\s*:\s*([A-Za-z0-9_-]{40,})\s*$/gm,               // YAML
];
const PEM = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |ED25519 )?PRIVATE KEY)-----([\s\S]{0,16384}?)-----END/g;
const edSeedOf = (full) => (full.subarray(0, 16).equals(ED25519_PKCS8) ? full.subarray(16, 48) : undefined);
const DER_B64 = [
  // A whole Ed25519 PKCS#8 (PEM body, a standalone base64 string): its seed gives the thumbprint.
  ["PKCS#8 Ed25519 (base64)", new RegExp(`${reEscape(ED25519_PKCS8.subarray(0, 15).toString("base64"))}[A-Za-z0-9+/_-]{44}`, "g"), (m) => ed25519Thumbprint(edSeedOf(b64(m)))],
  ["PKCS#8 Ed25519 (base64url)", new RegExp(`${reEscape(ED25519_PKCS8.subarray(0, 15).toString("base64url"))}[A-Za-z0-9_-]{44}`, "g"), (m) => ed25519Thumbprint(edSeedOf(b64(m)))],
  // Any private-key DER structure, at any alignment inside larger base64.
  ...DER_FRAGMENTS.map(([kind, frag]) => [`${kind} (base64)`, new RegExp(base64Forms(frag).map(reEscape).join("|"), "g")]),
  ["PKCS#1 RSA (base64)", /MII[A-Za-z0-9+/]{3}IBAAK[CB]/g],
  ["PKCS#8 Ed25519 (hex)", new RegExp(`${ED25519_PKCS8.toString("hex")}[0-9a-f]{64}`, "gi"), (m) => ed25519Thumbprint(Buffer.from(m.slice(32), "hex"))],
];
const SEALED = /"sealed"\s*:\s*\{\s*"v"\s*:\s*1\s*,\s*"kdf"/g;

/** Findings in one blob: [{ where, kind, thumbprint?, allowed? }]. gzip is unpacked (tarballs too). */
export function scanBuffer(buf, where, depth = 0) {
  const found = new Map();
  const add = (kind, tp) => {
    const k = `${kind}|${tp ?? ""}`;
    if (!found.has(k)) found.set(k, { where, kind, ...(tp ? { thumbprint: tp } : {}), ...(tp && PUBLIC_TEST_KEYS.has(tp) ? { allowed: PUBLIC_TEST_KEYS.get(tp) } : {}) });
  };
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && depth < 2) {
    let inner;
    try { inner = zlib.gunzipSync(buf, { maxOutputLength: MAX }); } catch { inner = undefined; }
    if (inner) {
      const entries = isTar(inner) ? [...tarEntries(inner)] : [{ name: "", data: inner }];
      return entries.flatMap((e) => scanBuffer(e.data, `${where}${e.name ? `!${e.name}` : " (gunzip)"}`, depth + 1)).concat(scanText(buf.toString("latin1"), where, add, found));
    }
  }
  return scanText(buf.toString("latin1"), where, add, found);
}

function scanText(text, where, add, found) {
  for (const re of D_PATTERNS) for (const m of text.matchAll(re)) {
    const bytes = b64(m[1]);
    add("JWK private member d", bytes.length === 32 ? ed25519Thumbprint(bytes) : undefined);
  }
  for (const m of text.matchAll(PEM)) {
    let tp;
    if (m[1] === "PRIVATE KEY") {
      const der = Buffer.from(m[2].replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
      if (der.subarray(0, 16).equals(ED25519_PKCS8)) tp = ed25519Thumbprint(der.subarray(16, 48));
    }
    add(`PEM ${m[1]}`, tp);
  }
  for (const [kind, re, tpOf] of DER_B64) for (const m of text.matchAll(re)) add(kind, tpOf?.(m[0]));
  for (const _ of text.matchAll(SEALED)) add("sealed Ludion Root keystore");
  return [...found.values()];
}

function isTar(buf) { return buf.length >= 512 && buf.subarray(257, 262).toString("latin1") === "ustar"; }
function* tarEntries(buf) {
  const str = (b) => b.toString("utf8").replace(/\0[\s\S]*$/, "");
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return;
    const name = str(h.subarray(0, 100)), prefix = str(h.subarray(345, 500));
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8) || 0;
    const type = h[156];
    off += 512;
    if (type === 0 || type === 0x30) yield { name: prefix ? `${prefix}/${name}` : name, data: buf.subarray(off, off + size) };
    off += Math.ceil(size / 512) * 512;
  }
}

const git = (cwd, args, opts = {}) => execFileSync("git", args, { cwd, maxBuffer: MAX, stdio: ["pipe", "pipe", "pipe"], ...opts });

/** Every blob reachable from any ref, with a path it appeared at. */
export function scanHistory(repo) {
  const pathOf = new Map();
  for (const line of git(repo, ["rev-list", "--all", "--objects"], { encoding: "utf8" }).split("\n")) {
    if (!line) continue;
    const i = line.indexOf(" ");
    const sha = i < 0 ? line : line.slice(0, i);
    if (!pathOf.has(sha)) pathOf.set(sha, i < 0 ? "" : line.slice(i + 1));
  }
  const commits = Number(git(repo, ["rev-list", "--all", "--count"], { encoding: "utf8" }).trim());
  const blobs = git(repo, ["cat-file", "--batch-check"], { input: [...pathOf.keys()].join("\n") + "\n", encoding: "utf8" })
    .split("\n").map((l) => l.split(" ")).filter((p) => p[1] === "blob").map((p) => p[0]);
  const out = git(repo, ["cat-file", "--batch"], { input: blobs.join("\n") + "\n" });
  const findings = [];
  let off = 0, n = 0;
  while (off < out.length) {
    const nl = out.indexOf(0x0a, off);
    const [sha, type, size] = out.subarray(off, nl).toString("latin1").split(" ");
    const start = nl + 1, end = start + Number(size);
    if (type === "blob") { n++; findings.push(...scanBuffer(out.subarray(start, end), `history ${sha.slice(0, 10)} ${pathOf.get(sha) || "(no path)"}`)); }
    off = end + 1;
  }
  return { findings, blobs: n, commits };
}

function walk(dir, skip, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p, e)) continue;
    if (e.isDirectory()) walk(p, skip, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
const posix = (p) => p.split(path.sep).join("/");
const skipDirs = (root) => (p, e) => e.isDirectory() && (["node_modules", ".git"].includes(e.name) || posix(path.relative(root, p)) === ".claude/worktrees");

/** Log-like files in a tree. */
export function scanLogs(root) {
  const isLog = (p) => /\.(log|jsonl|ndjson|gz)$/i.test(p) || /(^|[\\/])SCOREBOARD\.[^\\/]+$/.test(p) || /(^|[\\/])\.loop[\\/]/.test(p) || /npm-debug/.test(p);
  const files = walk(root, skipDirs(root)).filter(isLog);
  return { files: files.length, findings: files.flatMap((f) => scanBuffer(fs.readFileSync(f), `log ${posix(path.relative(root, f))}`)) };
}

/** Tracked and untracked-but-not-ignored files in the working tree. */
function scanWorktree(repo) {
  const files = git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean)
    .filter((f) => !f.startsWith(".claude/worktrees/") && fs.existsSync(path.join(repo, f)) && fs.statSync(path.join(repo, f)).isFile());
  return { files: files.length, findings: files.flatMap((f) => scanBuffer(fs.readFileSync(path.join(repo, f)), `worktree ${f}`)) };
}

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((c) => c && /npm-cli\.js$/.test(c) && fs.existsSync(c));
}
function npmPack(cwd, dest, extra = []) {
  const args = ["pack", ...extra, "--pack-destination", dest, "--silent"];
  const cli = npmCli();
  if (cli) execFileSync(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX });
  else execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args.map((a) => (process.platform === "win32" ? `"${a}"` : a)), { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", maxBuffer: MAX });
  return fs.readdirSync(dest).filter((f) => f.endsWith(".tgz")).map((f) => path.join(dest, f));
}

/** `npm pack` every workspace package and scan the tarballs' contents; plus any dist/ directory. */
function scanArtifacts(repo) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-reg4-pack-"));
  try {
    const tgz = npmPack(repo, dest, ["--workspaces"]);
    const dist = walk(repo, skipDirs(repo)).filter((f) => /(^|[\\/])dist[\\/]/.test(path.relative(repo, f)));
    const findings = [...tgz.flatMap((t) => scanBuffer(fs.readFileSync(t), `artifact ${path.basename(t)}`)),
      ...dist.flatMap((f) => scanBuffer(fs.readFileSync(f), `artifact ${posix(path.relative(repo, f))}`))];
    return { tarballs: tgz.length, dist: dist.length, findings };
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
}

// ── self-test: the scanner must catch what it claims to catch ────────────────────────────────
async function selfTest() {
  const problems = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-reg4-self-"));
  try {
    const ed = generateKeyPairSync("ed25519").privateKey, ed2 = generateKeyPairSync("ed25519").privateKey;
    const edJwk = ed.export({ format: "jwk" }), ed2Jwk = ed2.export({ format: "jwk" });
    const edTp = ed25519Thumbprint(Buffer.from(edJwk.d, "base64url"));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const x25519 = generateKeyPairSync("x25519").privateKey;
    const { sealRootKey } = await import("../../packages/diver/src/keys.mjs");
    const sealed = await sealRootKey({ kty: "OKP", crv: "Ed25519", x: edJwk.x, d: edJwk.d }, "reg4 self-test passphrase");
    const vectorD = RFC9421_TEST_SEED_B64U;
    const vectorX = createPublicKey(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, Buffer.from(vectorD, "base64url")]), format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
    const planted = {
      "jwk.json": [JSON.stringify(edJwk), "JWK private member d", edTp],
      "literal.mjs": [`export const k = { kty: "OKP", crv: "Ed25519", x: "${edJwk.x}", d: '${edJwk.d}' };\n`, "JWK private member d", edTp],
      "escaped.json": [JSON.stringify({ blob: JSON.stringify(edJwk) }), "JWK private member d", edTp],
      "config.yaml": [`kty: RSA\nd: ${rsa.export({ format: "jwk" }).d}\n`, "JWK private member d"],
      "ec.json": [JSON.stringify(ec.export({ format: "jwk" })), "JWK private member d"],
      "rsa.json": [JSON.stringify(rsa.export({ format: "jwk" })), "JWK private member d"],
      "ed.pem": [ed.export({ format: "pem", type: "pkcs8" }), "PEM PRIVATE KEY", edTp],
      "rsa1.pem": [rsa.export({ format: "pem", type: "pkcs1" }), "PEM RSA PRIVATE KEY"],
      "enc.pem": [ed.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "reg4 self-test passphrase" }), "PEM ENCRYPTED PRIVATE KEY"],
      "der.js": [`const der = "${ed.export({ format: "der", type: "pkcs8" }).toString("base64")}";\n`, "PKCS#8 Ed25519 (base64)", edTp],
      "der-hex.txt": [ed.export({ format: "der", type: "pkcs8" }).toString("hex"), "PKCS#8 Ed25519 (hex)", edTp],
      "rsa8.txt": [rsa.export({ format: "der", type: "pkcs8" }).toString("base64"), "PKCS#8 RSA (base64)"],
      "rsa1.txt": [rsa.export({ format: "der", type: "pkcs1" }).toString("base64"), "PKCS#1 RSA (base64)"],
      "ec8.txt": [ec.export({ format: "der", type: "pkcs8" }).toString("base64"), "PKCS#8 EC (base64)"],
      "x25519.txt": [x25519.export({ format: "der", type: "pkcs8" }).toString("base64"), "PKCS#8 X25519 (base64)"],
      "ludion.json": [JSON.stringify({ v: 0, root: sealed }, null, 2), "sealed Ludion Root keystore"],
      "packed.json.gz": [zlib.gzipSync(JSON.stringify(ed2Jwk)), "JWK private member d", ed25519Thumbprint(Buffer.from(ed2Jwk.d, "base64url"))],
    };
    const expect = (label, findings, file, [, kind, tp]) => {
      const hit = findings.find((f) => f.where.includes(file) && f.kind === kind && (!tp || f.thumbprint === tp) && !f.allowed);
      if (!hit) problems.push(`self-test (${label}): planted ${kind} in ${file} not detected`);
    };

    // 1. history: committed, then deleted, so the keys live only in history.
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q"]);
    for (const [f, [content]] of Object.entries(planted)) fs.writeFileSync(path.join(repo, f), content);
    fs.writeFileSync(path.join(repo, "vector.json"), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: vectorX, d: vectorD }));
    const id = ["-c", "user.name=reg4-self-test", "-c", "user.email=reg4@example.invalid", "-c", "core.autocrlf=false"];
    git(repo, [...id, "add", "-A"]);
    git(repo, [...id, "commit", "-q", "-m", "plant"]);
    git(repo, [...id, "rm", "-q", "-r", "."]);
    git(repo, [...id, "commit", "-q", "-m", "remove"]);
    if (fs.readdirSync(repo).some((f) => f !== ".git")) problems.push("self-test: planted files were not removed from the tree");
    const h = scanHistory(repo);
    for (const [f, spec] of Object.entries(planted)) expect("history", h.findings, f, spec);
    const vec = h.findings.filter((f) => f.where.includes("vector.json"));
    if (!vec.length || vec.some((f) => !f.allowed)) problems.push("self-test: the published RFC 9421 test key was not recognised by its thumbprint");
    if (h.findings.some((f) => f.allowed && !f.where.includes("vector.json"))) problems.push("self-test: a fresh key was treated as a published test vector");

    // 2. artifacts: a package tarball carrying a key.
    const pkg = path.join(tmp, "pkg");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "reg4-self-test", version: "0.0.0", files: ["key.pem"] }));
    fs.writeFileSync(path.join(pkg, "key.pem"), planted["ed.pem"][0]);
    const packDir = path.join(tmp, "packed");
    fs.mkdirSync(packDir);
    const a = npmPack(pkg, packDir).flatMap((t) => scanBuffer(fs.readFileSync(t), `artifact ${path.basename(t)}`));
    expect("artifact", a, "key.pem", planted["ed.pem"]);

    // 3. logs: a key printed into a log, one in a loop transcript, one in a gzip'd rotated log.
    const logs = path.join(tmp, "logs");
    fs.mkdirSync(path.join(logs, ".loop"), { recursive: true });
    fs.writeFileSync(path.join(logs, "app.log"), `2026-09-30 debug key=${planted["der.js"][0]}`);
    fs.writeFileSync(path.join(logs, ".loop", "iter-1.jsonl"), JSON.stringify({ tool_result: JSON.stringify(edJwk) }) + "\n");
    fs.writeFileSync(path.join(logs, "old.log.gz"), zlib.gzipSync(planted["ed.pem"][0]));
    const l = scanLogs(logs).findings;
    expect("log", l, "app.log", planted["der.js"]);
    expect("log", l, "iter-1.jsonl", planted["escaped.json"]);
    expect("log", l, "old.log.gz", planted["ed.pem"]);
  } catch (e) {
    problems.push(`self-test crashed: ${e?.message ?? e}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return problems;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const problems = await selfTest();
if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`\nself-test failed (${problems.length}); the scanner is not trustworthy, so the repo is not judged`);
  process.exit(1);
}
console.log("ok   self-test: planted keys caught in history, a tarball and logs; the RFC 9421 vector recognised by thumbprint");

const report = (label, r, what) => {
  const bad = r.findings.filter((f) => !f.allowed), allowed = r.findings.filter((f) => f.allowed);
  for (const f of bad) console.log(`FOUND ${f.kind} in ${f.where}${f.thumbprint ? ` (thumbprint ${f.thumbprint})` : ""}`);
  if (!bad.length) console.log(`ok   ${label}: ${what}, 0 private keys${allowed.length ? ` (${allowed.length} published test vector${allowed.length > 1 ? "s" : ""}: ${[...new Set(allowed.map((f) => f.allowed))].join(", ")})` : ""}`);
  return bad.length;
};
let bad = 0;
const h = scanHistory(ROOT);
bad += report("history", h, `${h.blobs} blobs in ${h.commits} commits`);
const w = scanWorktree(ROOT);
bad += report("worktree", w, `${w.files} files`);
const l = scanLogs(ROOT);
bad += report("logs", l, `${l.files} files`);
const a = scanArtifacts(ROOT);
bad += report("artifacts", a, `${a.tarballs} npm pack tarballs, ${a.dist} dist files`);
if (bad) { console.log(`\n${bad} private key finding(s)`); process.exit(1); }
