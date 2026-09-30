#!/usr/bin/env node
// Deploy the site to the PREVIEW Worker only (`*.workers.dev`), never to production.
//
//   npm run deploy:preview      (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment)
//
// Guards: the Worker name must be exactly PREVIEW_NAME, the config may carry no routes and no custom
// domains, and workers_dev must be on. Production (ludion.ai) is attached by a human, by hand
// (docs/DEPLOY.md §3). Writes site/preview.json { url, site } for WEB-1.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SITE, buildSite, siteHash, ensureDeps } from "./build.mjs";

export const PREVIEW_NAME = "ludion-site-preview";
const EDGE = path.join(SITE, "edge");

function guard(config) {
  const problems = [];
  if (config.name !== PREVIEW_NAME) problems.push(`the Worker is "${config.name}", not "${PREVIEW_NAME}"`);
  if (config.workers_dev !== true) problems.push("workers_dev is not true");
  for (const k of ["route", "routes"]) if (config[k] != null) problems.push(`config has "${k}" (a production route)`);
  if (config.env) problems.push("config has environments; deploy exactly one preview");
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!process.env[k]) { console.error(`set ${k} (see docs/DEPLOY.md §2)`); process.exit(2); }
  const config = JSON.parse(fs.readFileSync(path.join(EDGE, "wrangler.json"), "utf8"));
  const bad = guard(config);
  if (bad.length) { console.error(`refusing to deploy: ${bad.join("; ")}`); process.exit(2); }
  const dist = path.join(SITE, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  buildSite({ out: dist });
  const site = siteHash();
  ensureDeps(EDGE);
  const out = execFileSync(process.execPath, [path.join(EDGE, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "-c", path.join(EDGE, "wrangler.json")],
    { cwd: EDGE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" } });
  const url = (/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out) ?? [])[0];
  if (!url || !url.startsWith(`https://${PREVIEW_NAME}.`)) { console.error(`deployed, but no preview URL in wrangler's output:\n${out.slice(-1500)}`); process.exit(1); }
  fs.writeFileSync(path.join(SITE, "preview.json"), JSON.stringify({ url, site, deployedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`preview: ${url} (site ${site})`);
}

export { guard };
