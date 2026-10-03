// WEB-10 (−, the pair of WEB-4, property browser-scan): WEB-4's check of the /scan page cannot be
// passed by a page that shows other numbers than the CLI. The real site is built and served; a script
// run in the page before its own plants one fault per load — in the report the worker hands back (so
// the printed report and the tables agree with each other, but not with the CLI), or in what is drawn
// after it (the printed report stays right, what a person reads does not), or a page error. WEB-4's
// judge (./scan-page.mjs) must name each one. The unbent page is the control.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../build.mjs";
import { serve } from "../serve.mjs";
import { launchChromium } from "./browser.mjs";
import { cli, drop, pageProblems } from "./scan-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = path.join(ROOT, "accept/fixtures/logs/corpus");
// In name order: the page sorts what is dropped by name, as the CLI sorts a directory.
const FILES = ["caddy-access.log", "nginx-access.log"].map((f) => path.join(CORPUS, f));

let site, browser;
before(async () => { site = await serve(buildSite()); browser = await launchChromium(); });
after(async () => { await browser?.close(); await site?.close(); });

/** A page script: `report` bends the worker's report before the page draws it; `dom` bends the page after. */
const plant = ({ report = "", dom = "" }) => `(() => {
  const W = window.Worker;
  window.Worker = class extends W {
    set onmessage(fn) { super.onmessage = (ev) => { const m = ev.data; if (m && m.type === "done") { const r = m.report; ${report} } fn({ data: m }); }; }
    get onmessage() { return super.onmessage; }
  };
  new MutationObserver((_, obs) => {
    const root = document.querySelector(".ludion-scan");
    if (root?.dataset.state !== "done") return;
    obs.disconnect();
    const cells = (head) => [...document.querySelectorAll("#scan-result table.scan-table")].find((t) => t.querySelector("th")?.textContent.trim() === head);
    ${dom}
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
})();`;

const PLANTS = [
  ["the worker counts one record too many", { report: "r.totals.records += 1;" }, /printed report differs from the CLI's at \.totals\.records/],
  ["the worker leaves a file out of the report", { report: "r.files.pop();" }, /printed report differs|file table has 1 rows/],
  ["the worker swaps two classes", { report: "[r.classes.DECLARED, r.classes.SUSPECTED] = [r.classes.SUSPECTED, r.classes.DECLARED];" }, /printed report differs from the CLI's at \.classes/],
  ["the headline shows another number", { dom: "const h = document.querySelector('#scan-critical'); h.textContent = String(Number(h.textContent.replace(/\\D/g, '')) + 1);" }, /headline shows/],
  ["the class table shows a wrong count", { dom: "const row = [...cells('class').querySelectorAll('tbody tr')].find((tr) => tr.cells[0].textContent === 'SUSPECTED'); row.cells[1].textContent = '0';" }, /class table shows SUSPECTED 0/],
  ["the class table drops a class", { dom: "[...cells('class').querySelectorAll('tbody tr')].find((tr) => tr.cells[0].textContent === 'DECLARED').remove();" }, /class table rows/],
  ["the file table loses a row", { dom: "cells('file').querySelector('tbody tr:last-child').remove();" }, /file table has 1 rows, the CLI read 2 files/],
  ["the file table shows another parse rate", { dom: "cells('file').querySelector('tbody tr td:last-child').textContent = '100.0%';" }, /file table row 1 shows/],
];

test("WEB-10: WEB-4's judge passes the real page and catches every planted page", async () => {
  const want = cli(FILES);
  const errors = [];
  const control = await drop(browser, site.url + "/scan", FILES, { errors });
  assert.deepEqual(pageProblems(control, want, "en"), [], "control: the page as built");
  assert.deepEqual(errors, [], "control: no page error");
  const caught = [];
  for (const [what, bend, why] of PLANTS) {
    const got = await drop(browser, site.url + "/scan", FILES, { init: plant(bend), errors: [] });
    const p = pageProblems(got, want, "en");
    assert.ok(p.some((x) => why.test(x)), `${what}: not caught — ${JSON.stringify(p)}`);
    caught.push(what);
  }
  // A page that throws after drawing: WEB-4 holds every load to zero page errors.
  const thrown = [];
  await drop(browser, site.url + "/scan", FILES, { init: plant({ dom: "setTimeout(() => { throw new Error('planted'); });" }), errors: thrown });
  assert.ok(thrown.some((e) => /planted/.test(e)), `a page error is seen: ${JSON.stringify(thrown)}`);
  console.log(`WEB-10: ${caught.length + 1}/${PLANTS.length + 1} planted pages caught (${caught.length} by what they show, 1 by its page error); the real page passes`);
});
