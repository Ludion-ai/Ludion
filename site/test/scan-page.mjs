// The /scan page under test, shared by WEB-4 (the page equals the CLI) and WEB-10 (that check catches
// planted pages): drop files on the page in headless Chromium, read what it shows — the report it
// prints (#scan-json), the headline number, and the tables a person reads — and judge all of it
// against `ludion scan --json` on the same files.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STRINGS } from "../src/scan/strings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "packages/diver/bin/ludion.mjs");

/** `ludion scan <args> --json`, the real CLI in a child process (exit 1 = read no request, still a report). */
export function cli(args) {
  const r = spawnSync(process.execPath, [CLI, "scan", ...args, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6, timeout: 180_000 });
  assert.ok(r.status === 0 || (r.status === 1 && r.stdout.startsWith("{")), `exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/**
 * Open `url`, drop `files` on the scan, and read what the page shows. `init` is a script run in the
 * page before its own (WEB-10 plants faults with it). Page errors are pushed to `errors`.
 */
export async function drop(browser, url, files, { timeout = 120_000, init, errors = [] } = {}) {
  const context = await browser.newContext();
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const at = new URL(url).pathname;
  page.on("pageerror", (e) => errors.push(`${at}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${at}: console: ${m.text()}`); });
  try {
    const res = await page.goto(url);
    assert.equal(res.status(), 200, at);
    await page.waitForSelector('.ludion-scan[data-state="idle"]', { state: "attached" });
    const t0 = Date.now();
    await page.setInputFiles("#scan-input", files);
    await page.waitForSelector('.ludion-scan[data-state="done"], .ludion-scan[data-state="error"]', { state: "attached", timeout });
    const ms = Date.now() - t0;
    const state = await page.getAttribute(".ludion-scan", "data-state");
    assert.equal(state, "done", `${at}: ${await page.textContent("#scan-status")}`);
    await page.waitForTimeout(50); // let anything that runs after the drawing run (WEB-10's plants do)
    const tables = await page.$$eval("#scan-result table.scan-table", (ts) => ts.map((t) => ({
      head: [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim()),
      rows: [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())),
    })));
    return {
      report: JSON.parse(await page.textContent("#scan-json")),
      shown: (await page.textContent("#scan-critical")).trim(),
      lang: await page.getAttribute("html", "lang"),
      tables, ms,
    };
  } finally { await context.close(); }
}

const CLASSES = ["DECLARED", "SUSPECTED", "UNVERIFIED", "UNKNOWN"];
/** The first path where two JSON values differ, for a readable failure. */
function firstDiff(a, b, at = "") {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== "object") return a === b ? null : `${at || "."}: ${JSON.stringify(a)?.slice(0, 60)} ≠ ${JSON.stringify(b)?.slice(0, 60)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  return null;
}

/**
 * Everything the page (`got`, from drop) shows that is not the CLI's report `want`, in language `lang`:
 * the printed report field for field, the headline number, the class table, the file table.
 */
export function pageProblems(got, want, lang = "en") {
  const t = STRINGS[lang], nf = new Intl.NumberFormat(t.locale), fmt = (x) => nf.format(Number(x ?? 0));
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
  const out = [];
  const d = firstDiff(got.report, want);
  if (d) out.push(`the printed report differs from the CLI's at ${d}`);
  if (got.shown !== fmt(want.critical.unverified_automation)) out.push(`headline shows ${got.shown}, the CLI says ${fmt(want.critical.unverified_automation)}`);
  const classes = got.tables.find((x) => x.head.join("|") === t.classHead.join("|"));
  if (!classes) out.push("no class table");
  else {
    const rows = Object.fromEntries(classes.rows.map((r) => [r[0], r[1]]));
    const expect = CLASSES.filter((k) => k !== "UNVERIFIED" || want.classes.UNVERIFIED);
    if (Object.keys(rows).join(",") !== expect.join(",")) out.push(`class table rows ${Object.keys(rows).join(",")}, not ${expect.join(",")}`);
    for (const k of expect) if (rows[k] !== fmt(want.classes[k])) out.push(`class table shows ${k} ${rows[k]}, the CLI says ${fmt(want.classes[k])}`);
  }
  const files = got.tables.find((x) => x.head.join("|") === t.fileHead.join("|"));
  if (!files) out.push("no file table");
  else {
    const expect = [...want.files.map((f) => [f.name, f.format + (f.gzip ? " · gzip" : ""), fmt(f.records), pct(f.parsed, f.records)]),
      ...want.unrecognized.map((f) => [f.name, t.unrecognized, "", ""])];
    if (files.rows.length !== expect.length) out.push(`file table has ${files.rows.length} rows, the CLI read ${expect.length} files`);
    expect.forEach((e, i) => { const g = files.rows[i]; if (!g || g.join("|") !== e.join("|")) out.push(`file table row ${i + 1} shows ${g?.join(" | ")}, the CLI says ${e.join(" | ")}`); });
  }
  return out;
}
