// What WEB-4 holds the in-browser scan to, shared with WEB-11 (which plants faults to show it bites):
// drop files on /scan (or click the sample) in Chromium, read the report the page shows, and compare
// it with `ludion scan --json` on the same files, field for field, and the headline number.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS = path.join(ROOT, "accept/fixtures/logs/corpus");
const CLI = path.join(ROOT, "packages/diver/bin/ludion.mjs");

/** `ludion scan <args> --json`, the real CLI in a child process (exit 1 = read no request, still a report). */
export function cli(args) {
  const r = spawnSync(process.execPath, [CLI, "scan", ...args, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6, timeout: 180_000 });
  assert.ok(r.status === 0 || (r.status === 1 && r.stdout.startsWith("{")), `exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function onPage(browser, origin, urlPath, errors, act, { timeout = 120_000 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${urlPath}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${urlPath}: console: ${m.text()}`); });
  try {
    const res = await page.goto(origin + urlPath);
    assert.equal(res.status(), 200, urlPath);
    await page.waitForSelector('.ludion-scan[data-state="idle"]', { state: "attached" });
    const t0 = Date.now();
    await act(page);
    await page.waitForSelector('.ludion-scan[data-state="done"], .ludion-scan[data-state="error"]', { state: "attached", timeout });
    const ms = Date.now() - t0;
    const state = await page.getAttribute(".ludion-scan", "data-state");
    assert.equal(state, "done", `${urlPath}: ${await page.textContent("#scan-status")}`);
    return {
      report: JSON.parse(await page.textContent("#scan-json")),
      shown: (await page.textContent("#scan-critical")).trim(),
      lang: await page.getAttribute("html", "lang"),
      sampleNoted: await page.isVisible("#scan-sample-shown").catch(() => false),
      ms, page, context,
    };
  } catch (e) { await context.close(); throw e; }
}

/** Open /scan (or /ja/scan), drop files on it, and read what the page shows. */
export async function drop(browser, origin, urlPath, files, { errors = [], timeout } = {}) {
  const got = await onPage(browser, origin, urlPath, errors, (page) => page.setInputFiles("#scan-input", files), { timeout });
  await got.context.close();
  return got;
}

/** Open /scan (or /ja/scan), click "Try it with a sample log". The page stays open: close `context`. */
export function clickSample(browser, origin, urlPath, { errors = [] } = {}) {
  return onPage(browser, origin, urlPath, errors, (page) => page.click("#scan-sample"), { timeout: 60_000 });
}

/** The page's result is the CLI's: every field of the report, and the headline as the locale writes it. */
export function assertSameAsCli(got, want, locale, label) {
  assert.deepEqual(got.report, want, `${label}: the page's report differs from the CLI's`);
  assert.equal(got.shown, want.critical.unverified_automation.toLocaleString(locale), `${label}: the headline number`);
}
