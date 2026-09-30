#!/usr/bin/env node
// ludion — the CLI. Three minutes to register, one line to sign, one command to see the fear.
//
//   npx ludion init [--name "My Agent" --contact mailto:ops@example.com --domain dvr-xxx.agents.ludion.ai]
//   npx ludion sign <METHOD> <URL> [--body '{"a":1}']     # prints Web Bot Auth headers for curl/httpx/anything
//   npx ludion doctor                                      # self-check: keys, clock, directory, card
//   npx ludion scan <access.log|dir|-> [--json]            # log-first Gate: what touched what, unsigned
//
// Keys live in ./ludion.json (v0). The Root private key MUST move to a KMS/keychain
// before production (spec §12.4); the CLI warns while it is on disk.

import fs from "node:fs";
import path from "node:path";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, createDiverSigner } from "../src/index.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(`--${name}`);
const STORE = path.resolve(process.cwd(), "ludion.json");
const out = (s) => process.stdout.write(s + "\n");

async function init() {
  if (fs.existsSync(STORE) && !has("force")) return out(`ludion.json already exists. Use --force to overwrite (this creates a NEW identity).`);
  const root = await generateEd25519();
  const session = await generateEd25519();
  const diverId = diverIdFromRoot(root.publicJwk);
  const domain = flag("domain", `${diverId}.agents.ludion.ai`);
  const origin = `https://${domain}`;
  const store = {
    v: 0, diver_id: diverId, signature_agent: origin,
    name: flag("name", "Unnamed agent"), contacts: [flag("contact", "mailto:change-me@example.com")],
    root: root.privateJwk, session: session.privateJwk, created: new Date().toISOString(),
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
  const dir = directoryDocument([session.publicJwk]);
  const card = cardDocument({ origin, name: store.name, contacts: store.contacts, ludion: { diver_id: diverId, registry: "https://registry.ludion.ai", root_kid: root.kid } });
  fs.mkdirSync(".well-known", { recursive: true });
  fs.writeFileSync(path.join(".well-known", "http-message-signatures-directory"), JSON.stringify(dir, null, 2));
  fs.writeFileSync("card", JSON.stringify(card, null, 2));
  out(`✔ Diver created: ${diverId}`);
  out(`  Signature-Agent: ${origin}`);
  out(`  Wrote ludion.json (KEEP PRIVATE — Root key on disk is for development only)`);
  out(`  Wrote .well-known/http-message-signatures-directory  ← publish at ${origin}/.well-known/http-message-signatures-directory`);
  out(`  Wrote card                                            ← publish at ${origin}/card (Content-Type: application/json)`);
  out(`\nNext: host those two files at ${origin} (or run \`npx ludion register\` once the Registry is live), then:`);
  out(`  npx ludion sign GET https://example.com/`);
}

async function loadSigner() {
  if (!fs.existsSync(STORE)) throw new Error("no ludion.json — run `npx ludion init` first");
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
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

async function doctor() {
  const problems = [];
  let store;
  try { ({ store } = await loadSigner()); out(`✔ keys load (session kid ${store.session.kid})`); } catch (e) { return out(`✖ ${e.message}`); }
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

const commands = { init, sign: signCmd, doctor, scan };
if (!commands[cmd]) { out("usage: ludion <init|sign|doctor|scan> …"); process.exit(1); }
commands[cmd]().catch((e) => { console.error("✖", e.message); process.exit(1); });
