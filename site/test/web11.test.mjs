// WEB-11 (−, pair of WEB-4): WEB-4's check bites. The built site is copied, one fault is planted in
// each copy (in the scan worker, in the page, or in the shipped sample), and WEB-4's own comparison
// (scan-check.mjs: the report field for field, and the headline) is run against it. Every fault must
// be caught, by the rule that names it. An untouched copy, run the same way, must pass: the check
// fails the fakes, not everything.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSite } from "../build.mjs";
import { serve } from "../serve.mjs";
import { launchChromium } from "./browser.mjs";
import { CORPUS, cli, drop, clickSample, assertSameAsCli } from "./scan-check.mjs";

let dist, browser, tmp;
before(async () => {
  dist = buildSite();
  browser = await launchChromium();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-web11-"));
});
after(async () => {
  await browser?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const NGINX = path.join(CORPUS, "nginx-access.log"), APACHE = path.join(CORPUS, "apache-combined.log");

/** The scan worker's chunk in a built site. */
function workerFile(root) {
  const files = fs.readdirSync(path.join(root, "_astro")).filter((f) => /^worker-[^/]+\.js$/.test(f));
  assert.equal(files.length, 1, `one scan worker in _astro: ${files}`);
  return path.join(root, "_astro", files[0]);
}
const prepend = (file, js) => fs.writeFileSync(file, `${js}\n${fs.readFileSync(file, "utf8")}`);
const intoPages = (root, js) => {
  for (const page of ["scan.html", "ja/scan.html"]) {
    const f = path.join(root, page);
    const html = fs.readFileSync(f, "utf8");
    assert.ok(html.includes("<head>"), page);
    fs.writeFileSync(f, html.replace("<head>", `<head><script>${js}</script>`));
  }
};

/** What WEB-4 runs: drop the files (or click the sample) on /scan and /ja/scan, compare with the CLI. */
async function web4Check(origin, { files, sample = false }) {
  const want = cli(sample ? [NGINX] : files);
  for (const [urlPath, locale] of [["/scan", "en-US"], ["/ja/scan", "ja-JP"]]) {
    if (sample) {
      const got = await clickSample(browser, origin, urlPath);
      try { assertSameAsCli(got, want, locale, `${urlPath} (sample)`); } finally { await got.context.close(); }
    } else {
      assertSameAsCli(await drop(browser, origin, urlPath, files), want, locale, urlPath);
    }
  }
}

const FAULTS = [
  ["the worker counts one more on critical routes", { files: [NGINX] }, "report differs",
    (root) => prepend(workerFile(root), `{ const post = self.postMessage.bind(self); self.postMessage = (m) => { if (m && m.type === "done") m.report.critical.unverified_automation += 1; post(m); }; }`)],
  ["the worker leaves out the last file dropped", { files: [APACHE, NGINX] }, "report differs",
    (root) => prepend(workerFile(root), `Object.defineProperty(self, "onmessage", { configurable: true, set(h) { self.addEventListener("message", (e) => h({ data: { ...e.data, files: (e.data.files || []).slice(0, -1) } })); } });`)],
  ["the headline shows another field (the requests served)", { files: [NGINX] }, "headline number",
    (root) => intoPages(root, `new MutationObserver(() => { const r = document.querySelector(".ludion-scan"); const h = document.querySelector("#scan-critical"); const j = document.querySelector("#scan-json"); if (r && r.dataset.state === "done" && h && j && !h.dataset.x) { h.dataset.x = "1"; h.textContent = JSON.parse(j.textContent).critical.served.toLocaleString(document.documentElement.lang === "ja" ? "ja-JP" : "en-US"); } }).observe(document, { subtree: true, childList: true, attributes: true });`)],
  ["the sample is another log", { sample: true }, "report differs",
    (root) => fs.copyFileSync(APACHE, path.join(root, "samples", "nginx-access.log"))],
  ["the sample is cut short", { sample: true }, "report differs",
    (root) => { const f = path.join(root, "samples", "nginx-access.log"); const b = fs.readFileSync(f); fs.writeFileSync(f, b.subarray(0, b.length >> 1)); }],
];

async function onCopy(name, plant, fn) {
  const root = path.join(tmp, name.replace(/[^a-z0-9]+/gi, "-"));
  fs.cpSync(dist, root, { recursive: true });
  plant?.(root);
  const site = await serve(root);
  try { return await fn(site.url); } finally { await site.close(); }
}

test("WEB-11: an untouched copy of the built site passes WEB-4's check (drop and sample), so a catch below is the fault's", async () => {
  await onCopy("control", null, async (origin) => {
    await web4Check(origin, { files: [APACHE, NGINX] });
    await web4Check(origin, { sample: true });
  });
});

test("WEB-11: every fault planted in the scan (worker, page, sample) is caught by WEB-4's check, by the rule that names it", async () => {
  const missed = [];
  for (const [name, input, rule, plant] of FAULTS) {
    let caught = null;
    await onCopy(name, plant, async (origin) => {
      try { await web4Check(origin, input); } catch (e) { caught = e; }
    });
    if (!caught) missed.push(`${name}: not caught`);
    else if (!(caught instanceof assert.AssertionError) || !caught.message.includes(rule)) missed.push(`${name}: caught by something else: ${String(caught.message).split("\n")[0]}`);
  }
  assert.deepEqual(missed, []);
  console.log(`WEB-11: ${FAULTS.length} of ${FAULTS.length} planted faults caught by WEB-4's check; the untouched copy passes`);
});
