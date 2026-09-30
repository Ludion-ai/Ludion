#!/usr/bin/env node
// ludion — the CLI. Three minutes to register, one line to sign, one command to see the fear.
//
//   npx ludion init [--name "My Agent" --contact mailto:ops@example.com --domain dvr-xxx.agents.ludion.ai]
//   npx ludion sign <METHOD> <URL> [--body '{"a":1}']     # prints Web Bot Auth headers for curl/httpx/anything
//   npx ludion doctor                                      # self-check: keys, clock, directory, card
//   npx ludion scan <access.log> [--json]                  # log-first Gate: what touched what, unsigned
//
// Keys live in ./ludion.json (v0). The Root private key MUST move to a KMS/keychain
// before production (spec §12.4); the CLI warns while it is on disk.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, createDiverSigner } from "../src/index.mjs";
import { KNOWN_AGENT_TOKENS, AUTOMATION_SIGNALS } from "../../gate-core/src/agents.mjs";

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

// ---- scan: the log-first Gate ------------------------------------------------
const SENSITIVE = [
  ["checkout", /\/(checkout|cart|order|pay|payment|purchase)/i],
  ["login", /\/(login|signin|sign-in|auth|session|oauth|token)/i],
  ["account", /\/(account|profile|settings|dashboard|my)/i],
  ["signup", /\/(signup|register|sign-up)/i],
  ["form", /\/(contact|inquiry|apply|submit|comment|review)/i],
  ["search", /\/(search|s\?|q=)/i],
  ["api", /\/api\//i],
];
const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;

function classifyUA(ua) {
  const known = KNOWN_AGENT_TOKENS.find((k) => ua.includes(k.token));
  if (known) return { class: "DECLARED", who: known.operator, token: known.token };
  const l = ua.toLowerCase();
  const sig = AUTOMATION_SIGNALS.find((s) => l.includes(s));
  if (sig || !ua || ua === "-") return { class: "SUSPECTED", who: sig ?? "no-user-agent" };
  return { class: "UNKNOWN" };
}

async function scan() {
  const file = args[1];
  if (!file) return out("usage: ludion scan <access.log> [--json]   (nginx/apache combined, or JSON lines with user_agent/ua + path/request)");
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const stats = { lines: 0, parsed: 0, byClass: {}, operators: {}, touches: {}, signed: 0, first: null, last: null };
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for await (const line of rl) {
    stats.lines++;
    let ip, ts, method, pathq, ua, signed = false;
    if (line.startsWith("{")) {
      try { const j = JSON.parse(line); ip = j.ip ?? j.client_ip ?? j.remote_addr; ts = j.time ?? j.timestamp ?? j.ts; method = j.method ?? j.request_method ?? (j.request ?? "").split(" ")[0]; pathq = j.path ?? j.uri ?? j.request_uri ?? (j.request ?? "").split(" ")[1] ?? ""; ua = j.user_agent ?? j.ua ?? j.http_user_agent ?? ""; signed = !!(j.signature_agent ?? j["signature-agent"] ?? j.signature_input); } catch { continue; }
    } else {
      const m = COMBINED.exec(line); if (!m) continue;
      [, ip, ts, method, pathq, , , ua] = m;
    }
    stats.parsed++;
    if (!stats.first) stats.first = ts; stats.last = ts;
    if (signed) { stats.signed++; continue; } // cannot verify from a log; counted separately
    const c = classifyUA(ua ?? "");
    bump(stats.byClass, c.class);
    if (c.class === "UNKNOWN") continue;
    bump(stats.operators, c.who);
    const [kind] = SENSITIVE.find(([, re]) => re.test(pathq)) ?? ["other"];
    stats.touches[kind] ??= {}; bump(stats.touches[kind], c.class);
    if (/^(POST|PUT|PATCH|DELETE)$/i.test(method)) { stats.touches[kind]._writes = (stats.touches[kind]._writes ?? 0) + 1; }
  }
  const auto = (stats.byClass.DECLARED ?? 0) + (stats.byClass.SUSPECTED ?? 0);
  const fear = Object.entries(stats.touches).filter(([k]) => ["checkout", "login", "account", "signup"].includes(k))
    .reduce((n, [, v]) => n + (v.DECLARED ?? 0) + (v.SUSPECTED ?? 0), 0);
  if (has("json")) return out(JSON.stringify({ ...stats, automation: auto, unverified_touches_on_critical_routes: fear }, null, 2));
  out(`Ludion scan — ${path.basename(file)}  (${stats.parsed}/${stats.lines} lines parsed, ${stats.first} → ${stats.last})`);
  out(`\nAutomation seen (unsigned, so unverifiable): ${auto}   declared: ${stats.byClass.DECLARED ?? 0}   suspected: ${stats.byClass.SUSPECTED ?? 0}   signed (not verifiable from a log): ${stats.signed}`);
  out(`\nWho (by declared token / signal):`);
  Object.entries(stats.operators).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => out(`  ${String(v).padStart(8)}  ${k}`));
  out(`\nWhat they touched:`);
  for (const [k, v] of Object.entries(stats.touches).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))) {
    out(`  ${k.padEnd(9)} declared ${String(v.DECLARED ?? 0).padStart(6)}   suspected ${String(v.SUSPECTED ?? 0).padStart(6)}   writes ${String(v._writes ?? 0).padStart(6)}`);
  }
  out(`\n▶ UNVERIFIED AUTOMATION ON CRITICAL ROUTES (checkout/login/account/signup): ${fear}`);
  out(`  Every one of these was accepted with no way to know whose agent it was, what it was allowed to do, or who pays if it broke something.`);
  out(`\nNext: install Ludion Gate (Pressure 0 = observe only) to verify signatures live → https://ludion.ai/gate`);
}

const commands = { init, sign: signCmd, doctor, scan };
if (!commands[cmd]) { out("usage: ludion <init|sign|doctor|scan> …"); process.exit(1); }
commands[cmd]().catch((e) => { console.error("✖", e.message); process.exit(1); });
