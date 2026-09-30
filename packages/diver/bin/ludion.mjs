#!/usr/bin/env node
// ludion — the CLI. Three minutes to register, one line to sign, one command to see the fear.
//
//   npx ludion init [--name "My Agent" --contact mailto:ops@example.com --domain dvr-xxx.agents.ludion.ai] [--dev]
//   npx ludion sign <METHOD> <URL> [--body '{"a":1}']     # prints Web Bot Auth headers for curl/httpx/anything
//   npx ludion rotate [--overlap 300] [--force]            # session key: publish the next one, then (after the overlap) switch
//   npx ludion doctor                                      # self-check: keys, clock, directory, card
//   npx ludion scan <access.log|dir|-> [--json]            # log-first Gate: what touched what, unsigned
//   npx ludion report --events <events.ndjson> [--date D] [--tz Asia/Tokyo] [--lang ja] [--format html]  # the daily report
//
// Keys live in ./ludion.json (v0). The Root private key is sealed there with the operator's
// passphrase (LUDION_ROOT_PASSPHRASE, or a prompt on a terminal): scrypt + AES-256-GCM, see
// docs/adr/ADR-019. Only `--dev` (or LUDION_DEV=1) stores it in plaintext, and every command
// then says so on stderr. KMS / OS keychain backends are next (spec §12.4).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, createDiverSigner, sealRootKey, isSealedRoot, MIN_PASSPHRASE_LENGTH,
  rotateSession, RotationPendingError, DEFAULT_OVERLAP_S } from "../src/index.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(`--${name}`);
const STORE = path.resolve(process.cwd(), "ludion.json");
const out = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const DEV = has("dev") || process.env.LUDION_DEV === "1";

function devBanner() {
  err("⚠ ────────────────────────────────────────────────────────────────────────");
  err("⚠  LUDION DEV MODE: the Root private key is stored in PLAINTEXT in ludion.json.");
  err("⚠  Whoever reads that file owns this identity. Development only: never register");
  err("⚠  or use a dev identity in production. `ludion init --force` without --dev seals it.");
  err("⚠ ────────────────────────────────────────────────────────────────────────");
}

/** Read a line from the terminal without echoing it. Terminal only; nothing is written anywhere. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (chunk) => { if (chunk.includes(question)) rl.output.write(chunk); };
    rl.question(question, (answer) => { rl.close(); process.stderr.write("\n"); resolve(answer); });
  });
}

async function rootPassphrase({ confirm }) {
  if (process.env.LUDION_ROOT_PASSPHRASE) return process.env.LUDION_ROOT_PASSPHRASE;
  if (!process.stdin.isTTY) return undefined;
  const a = await promptHidden(`Root passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `);
  if (confirm && a !== await promptHidden("Repeat the passphrase: ")) throw new Error("the passphrases do not match. Nothing was written.");
  return a;
}

/** Write a private file atomically (temp file in the same directory, then rename), owner-only. */
function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function init() {
  if (fs.existsSync(STORE) && !has("force")) return out(`ludion.json already exists. Use --force to overwrite (this creates a NEW identity).`);
  let passphrase;
  if (!DEV) {
    passphrase = await rootPassphrase({ confirm: true });
    if (!passphrase) throw new Error(`the Root key must be protected. Set LUDION_ROOT_PASSPHRASE (at least ${MIN_PASSPHRASE_LENGTH} characters), run \`ludion init\` in a terminal to be prompted, or pass --dev for a throwaway development identity (plaintext Root). Nothing was written.`);
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`the Root passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. Nothing was written.`);
  }
  const root = await generateEd25519();
  const session = await generateEd25519();
  const diverId = diverIdFromRoot(root.publicJwk);
  const domain = flag("domain", `${diverId}.agents.ludion.ai`);
  const origin = `https://${domain}`;
  const store = {
    v: 0, ...(DEV ? { dev: true } : {}), diver_id: diverId, signature_agent: origin,
    name: flag("name", "Unnamed agent"), contacts: [flag("contact", "mailto:change-me@example.com")],
    root: DEV ? root.privateJwk : await sealRootKey(root.privateJwk, passphrase),
    session: session.privateJwk, created: new Date().toISOString(),
  };
  writePrivate(STORE, JSON.stringify(store, null, 2));
  const dir = directoryDocument([session.publicJwk]);
  const card = cardDocument({ origin, name: store.name, contacts: store.contacts, ludion: { diver_id: diverId, registry: "https://registry.ludion.ai", root_kid: root.kid } });
  fs.mkdirSync(".well-known", { recursive: true });
  fs.writeFileSync(path.join(".well-known", "http-message-signatures-directory"), JSON.stringify(dir, null, 2));
  fs.writeFileSync("card", JSON.stringify(card, null, 2));
  out(`✔ Diver created: ${diverId}`);
  out(`  Signature-Agent: ${origin}`);
  if (DEV) devBanner();
  out(`  Wrote ludion.json (KEEP PRIVATE — ${DEV ? "DEV MODE: Root key in plaintext" : "Root key sealed with your passphrase; the passphrase is not stored"})`);
  out(`  Wrote .well-known/http-message-signatures-directory  ← publish at ${origin}/.well-known/http-message-signatures-directory`);
  out(`  Wrote card                                            ← publish at ${origin}/card (Content-Type: application/json)`);
  out(`\nNext: host those two files at ${origin} (or run \`npx ludion register\` once the Registry is live), then:`);
  out(`  npx ludion sign GET https://example.com/`);
}

async function loadSigner() {
  if (!fs.existsSync(STORE)) throw new Error("no ludion.json — run `npx ludion init` first");
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (store.dev) devBanner();
  else if (!isSealedRoot(store.root)) err("⚠ ludion.json holds the Root private key in plaintext (made by an older ludion, or edited by hand). Treat this identity as development-only and create a sealed one with `ludion init --force`.");
  const signer = await createDiverSigner({ sessionPrivateJwk: store.session, signatureAgent: store.signature_agent, insecureAllowHttp: has("insecure") });
  return { store, signer };
}

async function signCmd() {
  const [, method, url] = args;
  if (!method || !url) return out("usage: ludion sign <METHOD> <URL> [--body '...'] [--curl]");
  const { signer } = await loadSigner();
  const body = flag("body");
  const headers = await signer.headersFor({ method, url, headers: body ? { "content-type": "application/json" } : {}, body });
  if (has("curl")) {
    out(`curl -X ${method.toUpperCase()} ${Object.entries(headers).map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`).join(" \\\n  ")}${body ? ` \\\n  -d '${body}'` : ""} \\\n  '${url}'`);
  } else {
    for (const [k, v] of Object.entries(headers)) out(`${k}: ${v}`);
  }
  out(`\n# expires in 60s. Generate per request; never reuse (draft §6.9).`);
}

async function rotate() {
  const { store } = await loadSigner();
  const overlapS = Number(flag("overlap", DEFAULT_OVERLAP_S));
  let r;
  try { r = await rotateSession(store, { overlapS, force: has("force") }); }
  catch (e) {
    if (!(e instanceof RotationPendingError)) throw e;
    const wait = Math.ceil((e.activeAt - Date.now()) / 1000);
    throw new Error(`${e.message} (in ${wait}s), when every verifier's cached directory has had time to pick it up. Run \`ludion rotate\` again then. --force switches now, and Gates that still cache the old directory will not find the new key until their cache expires.`);
  }
  const dirFile = path.join(".well-known", "http-message-signatures-directory");
  fs.mkdirSync(".well-known", { recursive: true });
  // Publishing: directory first (a crash leaves an unused key published). Activating: store first
  // (a crash leaves the old key published a little longer, never a signing key that is unpublished).
  if (r.step === "published") { fs.writeFileSync(dirFile, JSON.stringify(r.directory, null, 2)); writePrivate(STORE, JSON.stringify(r.store, null, 2)); }
  else { writePrivate(STORE, JSON.stringify(r.store, null, 2)); fs.writeFileSync(dirFile, JSON.stringify(r.directory, null, 2)); }
  if (r.step === "published") {
    out(`✔ Next session key published: ${r.store.next.kid} (still signing with ${store.session.kid})`);
    out(`  It becomes active at ${r.store.next.active_at}. Run \`ludion rotate\` again then.`);
  } else {
    out(`✔ Now signing with ${r.store.session.kid}; ${store.session.kid} left the directory and the store.`);
    out(`  Verifiers stop accepting the old key when their cached directory expires.`);
  }
  out(`  Wrote ${dirFile.split(path.sep).join("/")}  ← publish it again at ${store.signature_agent}/.well-known/http-message-signatures-directory`);
}

async function doctor() {
  const problems = [];
  let store;
  try { ({ store } = await loadSigner()); out(`✔ keys load (session kid ${store.session.kid})`); } catch (e) { return out(`✖ ${e.message}`); }
  if (isSealedRoot(store.root)) out(`✔ Root sealed (${store.root.sealed.kdf} + ${store.root.sealed.cipher}), kid ${store.root.kid}`);
  else problems.push(`${store.dev ? "DEV MODE: " : ""}the Root private key is in plaintext on disk`);
  if (!/^dvr-[a-z2-7]{16}$/.test(store.diver_id)) problems.push("diver_id malformed");
  const skew = Math.abs(Date.now() - Date.now()); // placeholder: compare against a time source in v0.1
  out(`✔ clock: local time ${new Date().toISOString()} (no external time check yet; signatures allow ±30s)`);
  const origin = store.signature_agent;
  for (const p of ["/.well-known/http-message-signatures-directory", "/card"]) {
    try {
      const r = await fetch(origin + p, { redirect: "manual" });
      const okType = p === "/card" || (r.headers.get("content-type") ?? "").includes("http-message-signatures-directory+json");
      if (r.status !== 200) problems.push(`${p} returned ${r.status} (must be 200, no redirect)`);
      else if (!okType) problems.push(`${p} served with ${r.headers.get("content-type")} — must be application/http-message-signatures-directory+json`);
      else {
        const j = await r.json();
        if (p !== "/card" && !j.keys?.some((k) => k.kid === store.session.kid)) problems.push("directory does not contain the current session key");
        if (p === "/card" && j.client_id !== `${origin}/card`) problems.push("card client_id must equal its URL");
        if (!problems.length) out(`✔ ${origin}${p}`);
      }
    } catch (e) { problems.push(`${p} unreachable: ${e.message}`); }
  }
  if (problems.length) { out(`\n${problems.length} problem(s):`); problems.forEach((p) => out(`  ✖ ${p}`)); process.exitCode = 1; }
  else out(`\nAll good. Sites running Ludion Gate will see you as VERIFIED (depth 0 until you register).`);
}

// ---- scan: the log-first Gate (@ludion/scan) ---------------------------------
async function scan() {
  const { main } = await import("@ludion/scan/cli");
  process.exitCode = await main(args.slice(1));
}

// ---- report: the daily report from the Gate's metadata events (@ludion/report) ----
async function report() {
  const { main } = await import("@ludion/report/cli");
  process.exitCode = await main(args.slice(1));
}

const commands = { init, sign: signCmd, rotate, doctor, scan, report };
if (!commands[cmd]) { out("usage: ludion <init|sign|rotate|doctor|scan|report> …"); process.exit(1); }
commands[cmd]().catch((e) => { console.error("✖", e.message); process.exit(1); });
