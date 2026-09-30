// Cloudflare credentials for the preview deploy and the read-only inventory. A local file wins over
// the environment, because a terminal can carry a stale token: ~/.config/ludion/cloudflare.env
//   CLOUDFLARE_API_TOKEN=...
//   CLOUDFLARE_ACCOUNT_ID=...
// The file stays on this machine (outside the repo). Values are never printed; only where they came from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CF_ENV_FILE = path.join(os.homedir(), ".config", "ludion", "cloudflare.env");
const KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/** Load the file into process.env (overriding). @returns {string} where the credentials came from */
export function loadCloudflareEnv(file = CF_ENV_FILE) {
  if (!fs.existsSync(file)) return KEYS.every((k) => process.env[k]) ? "environment" : "missing";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]*)"?\s*$/.exec(line);
    if (m && KEYS.includes(m[1]) && m[2]) process.env[m[1]] = m[2];
  }
  return `file ${file}`;
}
