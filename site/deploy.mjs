#!/usr/bin/env node
// Deploy the site to the PREVIEW Worker only (`*.workers.dev`), never to production.
//
//   npm run deploy:preview                  (credentials: ~/.config/ludion/cloudflare.env, see scripts/cf-env.mjs)
//   node site/deploy.mjs --check            (the boundary check alone; deploys nothing)
//
// Guards: the Worker name must be exactly PREVIEW_NAME, the config may carry no routes and no custom
// domains, and workers_dev must be on. Production (ludion.ai) is attached by a human, by hand
// (docs/DEPLOY.md §3). Before any of that, the credential itself is checked (boundary): the account is
// PREVIEW_ACCOUNT and the token reaches Workers in no other account. Secrets for the preview Worker come
// from SECRETS_FILE, uploaded with the deploy. Writes site/preview.json { url, site } for WEB-1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SITE, buildSite, siteHash, ensureDeps } from "./build.mjs";
import { loadCloudflareEnv } from "../scripts/cf-env.mjs";

export const PREVIEW_NAME = "ludion-site-preview";
export const PREVIEW_ACCOUNT = "Ludion Agents";
export const SECRETS_FILE = path.join(os.homedir(), ".config", "ludion", "signup.env");
export const SECRET_KEYS = ["SIGNUP_WEBHOOK_URL"];
const EDGE = path.join(SITE, "edge");

function guard(config) {
  const problems = [];
  if (config.name !== PREVIEW_NAME) problems.push(`the Worker is "${config.name}", not "${PREVIEW_NAME}"`);
  if (config.workers_dev !== true) problems.push("workers_dev is not true");
  for (const k of ["route", "routes"]) if (config[k] != null) problems.push(`config has "${k}" (a production route)`);
  if (config.env) problems.push("config has environments; deploy exactly one preview");
  return problems;
}

/**
 * The boundary is the credential (docs/DEPLOY.md §5): the token may reach Workers in PREVIEW_ACCOUNT and
 * nowhere else, and sees no zone (the preview lives on workers.dev). GET only. Fails closed: for another
 * account, anything but a refusal (401/403) counts as reach.
 * @param {(path: string) => Promise<{ status: number, ok: boolean, result?: any }>} get Cloudflare API GET
 * @param {string} account CLOUDFLARE_ACCOUNT_ID
 */
async function boundary(get, account) {
  const problems = [], report = [];
  const denied = (r) => r.status === 401 || r.status === 403;
  const accounts = await get("/accounts?per_page=50");
  if (!accounts.ok || !Array.isArray(accounts.result)) return { problems: [`cannot list the token's accounts (${accounts.status})`], report };
  const target = accounts.result.find((a) => a.id === account);
  if (!target) problems.push("CLOUDFLARE_ACCOUNT_ID is not an account this token can see");
  else if (target.name !== PREVIEW_ACCOUNT) problems.push(`CLOUDFLARE_ACCOUNT_ID is "${target.name}", not "${PREVIEW_ACCOUNT}"`);
  else {
    const sub = await get(`/accounts/${account}/workers/subdomain`);
    if (!sub.ok || !sub.result?.subdomain) problems.push(`"${PREVIEW_ACCOUNT}" has no workers.dev subdomain: open Workers & Pages in its dashboard once`);
    else report.push(`"${target.name}": target, workers.dev subdomain "${sub.result.subdomain}"`);
  }
  for (const a of accounts.result.filter((x) => x.id !== account)) {
    const r = await get(`/accounts/${a.id}/workers/scripts`);
    report.push(`"${a.name}": Workers ${denied(r) ? `denied (${r.status})` : r.ok ? "READABLE" : `unclear (${r.status})`}`);
    if (!denied(r)) problems.push(`the token ${r.ok ? "reads" : "may reach"} Workers in "${a.name}"`);
  }
  const zones = await get("/zones?per_page=50");
  const nz = zones.ok && Array.isArray(zones.result) ? zones.result.length : null;
  report.push(`zones: ${denied(zones) ? `denied (${zones.status})` : nz != null ? nz : `unclear (${zones.status})`}`);
  if (!denied(zones) && nz !== 0) problems.push(nz ? `the token sees ${nz} zone(s): ${zones.result.map((z) => z.name).join(", ")}` : `cannot tell which zones the token sees (${zones.status})`);
  return { problems, report };
}

/** Keys in a .env text. The secrets file may hold only SECRET_KEYS: it is uploaded whole. */
function secretKeys(text) {
  return text.split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean);
}

function cloudflare(token) {
  return async (p) => {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, ok: r.ok && j.success === true, result: j.result };
    } catch { return { status: 0, ok: false }; }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(`credentials: ${loadCloudflareEnv()}`);
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!process.env[k]) { console.error(`set ${k} (see docs/DEPLOY.md §2)`); process.exit(2); }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, api = cloudflare(process.env.CLOUDFLARE_API_TOKEN);
  const b = await boundary(api, account);
  for (const line of b.report) console.error(`boundary: ${line}`);
  if (b.problems.length) { console.error(`refusing to deploy: ${b.problems.join("; ")} (docs/DEPLOY.md §5)`); process.exit(2); }
  if (process.argv.includes("--check")) { console.error("boundary: ok"); process.exit(0); }
  const config = JSON.parse(fs.readFileSync(path.join(EDGE, "wrangler.json"), "utf8"));
  const bad = guard(config);
  if (bad.length) { console.error(`refusing to deploy: ${bad.join("; ")}`); process.exit(2); }
  const secrets = fs.existsSync(SECRETS_FILE) ? secretKeys(fs.readFileSync(SECRETS_FILE, "utf8")) : [];
  const stray = secrets.filter((k) => !SECRET_KEYS.includes(k));
  if (stray.length) { console.error(`refusing to deploy: ${SECRETS_FILE} holds ${stray.join(", ")}; it may hold only ${SECRET_KEYS.join(", ")}`); process.exit(2); }
  const dist = path.join(SITE, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  buildSite({ out: dist });
  const site = siteHash();
  ensureDeps(EDGE);
  const out = execFileSync(process.execPath, [path.join(EDGE, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "-c", path.join(EDGE, "wrangler.json"), ...(secrets.length ? ["--secrets-file", SECRETS_FILE] : [])],
    { cwd: EDGE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" } });
  const url = (/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out) ?? [])[0];
  if (!url || !url.startsWith(`https://${PREVIEW_NAME}.`)) { console.error(`deployed, but no preview URL in wrangler's output:\n${out.slice(-1500)}`); process.exit(1); }
  fs.writeFileSync(path.join(SITE, "preview.json"), JSON.stringify({ url, site, deployedAt: new Date().toISOString() }, null, 2) + "\n");
  // Secret names only, read back from the Worker: the signup form answers 503 without its webhook (WEB-8).
  const s = await api(`/accounts/${account}/workers/scripts/${PREVIEW_NAME}/secrets`);
  const names = s.ok ? s.result.map((x) => x.name) : [];
  const missing = secrets.filter((k) => !names.includes(k));
  console.log(`preview: ${url} (site ${site}); secrets on the Worker: ${s.ok ? names.join(", ") || "(none)" : `unreadable (${s.status})`}`);
  if (missing.length) { console.error(`deployed, but the Worker lacks ${missing.join(", ")}`); process.exit(1); }
}

export { guard, boundary, secretKeys };
