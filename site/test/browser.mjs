// Headless Chromium for the site oracles (WEB-4, WEB-6; WEB-5 next). playwright-core comes
// from the site's lockfile; the browser build that version pins is installed on first use into
// Playwright's shared cache (PLAYWRIGHT_BROWSERS_PATH, else the OS default), then reused.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SITE, ensureDeps } from "../build.mjs";

const MISSING = /Executable doesn't exist|playwright(-core)? install|browserType\.launch: .*not found/i;

function install() {
  execFileSync(process.execPath, [path.join(SITE, "node_modules", "playwright-core", "cli.js"), "install", "chromium-headless-shell"],
    { cwd: SITE, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 600_000, maxBuffer: 64e6 });
}

/** @returns {Promise<import("playwright-core").Browser>} `options` go to `chromium.launch` (e.g. a proxy). */
export async function launchChromium(options = {}) {
  ensureDeps();
  const { chromium } = await import(pathToFileURL(path.join(SITE, "node_modules", "playwright-core", "index.mjs")).href);
  try { return await chromium.launch({ headless: true, ...options }); }
  catch (e) {
    if (!MISSING.test(String(e?.message))) throw e;
    install();
    return chromium.launch({ headless: true, ...options });
  }
}
