// WEB-4 (+, pair WEB-11): the in-browser scan at /scan gives exactly the CLI's numbers. The site is
// built for real and served the way a static host serves it; headless Chromium drops every SCAN
// fixture on the page (one by one, then all at once, in English and in Japanese) and the report
// the page shows must equal `ludion scan --json` on the same files, field for field. Then 200 MiB
// of nginx logs must be read in ≤30 s, every line counted and classed as written.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildSite } from "../build.mjs";
import { serve } from "../serve.mjs";
import { launchChromium } from "./browser.mjs";
import { ROOT, CORPUS, cli, drop as dropOn, clickSample, assertSameAsCli } from "./scan-check.mjs";

const BIG = 200 * 1024 ** 2, LIMIT_S = 30;

let site, browser, tmp;
const errors = [];

before(async () => {
  site = await serve(buildSite());
  browser = await launchChromium();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-web4-"));
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Open /scan (or /ja/scan), drop files on it, and read what the page shows (scan-check.mjs, shared with WEB-11). */
const drop = (urlPath, files, opts = {}) => dropOn(browser, site.url, urlPath, files, { errors, ...opts });

const fixtures = fs.readdirSync(CORPUS).filter((f) => !f.startsWith(".")).sort();

test("WEB-4: every SCAN fixture dropped on /scan gives the CLI's report, field for field", async () => {
  assert.ok(fixtures.length >= 9, `fixtures: ${fixtures.length}`);
  let gz = 0;
  for (const f of fixtures) {
    const file = path.join(CORPUS, f);
    const want = cli([file]);
    const got = await drop("/scan", [file]);
    assert.ok(want.totals.records > 0, `${f}: the CLI read nothing`);
    assertSameAsCli(got, want, "en-US", f);
    if (want.files[0]?.gzip) gz++;
  }
  assert.ok(gz >= 2, `gzip fixtures exercised: ${gz}`);
  assert.deepEqual(errors, [], "page errors");
});

test("WEB-4: edge inputs read like the CLI: concatenated gzip members, BOM + CRLF + no final newline, not a log", async () => {
  const plain = fixtures.filter((f) => !f.endsWith(".gz")).map((f) => fs.readFileSync(path.join(CORPUS, f)));
  const cases = {
    // `cat a.gz b.gz` (and some log shippers) make one file of several gzip members.
    "members.log.gz": Buffer.concat([zlib.gzipSync(plain[0]), zlib.gzipSync(plain[0].subarray(0, 4000)), zlib.gzipSync(plain[0])]),
    // A stored (level 0) member whose data holds a gzip header's bytes: a boundary that is not one.
    "members-stored.log.gz": Buffer.concat([
      zlib.gzipSync(Buffer.concat([plain[1], Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x0a]), plain[1]]), { level: 0 }), zlib.gzipSync(plain[2])]),
    "bom-crlf.log": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plain[0].toString("utf8").replace(/\n/g, "\r\n").replace(/\r\n$/, ""))]),
    "notes.txt": Buffer.from("these are not the logs you are looking for\n".repeat(50)),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, bytes);
    const want = cli([file]);
    const got = await drop("/scan", [file]);
    assert.deepEqual(got.report, want, `${name}: the page's report differs from the CLI's`);
  }
  assert.deepEqual(errors, [], "page errors");
});

test("WEB-4: the whole corpus dropped at once, on /scan and /ja/scan, equals `ludion scan <dir>`", async () => {
  const want = cli([CORPUS]);
  assert.ok(want.totals.records > 1000 && want.critical.unverified_automation > 100, "the corpus must carry the number");
  // Dropped in reverse order: the page sorts by name, as the CLI sorts a directory.
  const files = fixtures.map((f) => path.join(CORPUS, f)).reverse();
  for (const [urlPath, lang, locale] of [["/scan", "en", "en-US"], ["/ja/scan", "ja", "ja-JP"]]) {
    const got = await drop(urlPath, files);
    assert.equal(got.lang, lang, `${urlPath}: <html lang>`);
    assertSameAsCli(got, want, locale, urlPath);
  }
  assert.deepEqual(errors, [], "page errors");
});

test("WEB-4: 'Try it with a sample log' reads the shipped nginx corpus file like a dropped one, and says it is a sample", async () => {
  const corpusFile = path.join(CORPUS, "nginx-access.log");
  assert.deepEqual(fs.readFileSync(path.join(ROOT, "site/public/samples/nginx-access.log")), fs.readFileSync(corpusFile), "the sample is the corpus file");
  const want = cli([corpusFile]);
  for (const [urlPath, locale] of [["/scan", "en-US"], ["/ja/scan", "ja-JP"]]) {
    const got = await clickSample(browser, site.url, urlPath, { errors });
    const { page, context } = got;
    try {
      assertSameAsCli(got, want, locale, `${urlPath} (sample)`);
      assert.ok(got.sampleNoted, `${urlPath}: the result says it is the sample's`);
      // Then the visitor's own log: the sample note is gone.
      await page.setInputFiles("#scan-input", [path.join(CORPUS, "apache-combined.log")]);
      await page.waitForFunction(() => document.querySelector(".ludion-scan")?.dataset.sample === "false" && document.querySelector(".ludion-scan")?.dataset.state === "done");
      assert.equal(await page.$("#scan-sample-shown"), null, `${urlPath}: a dropped log is not called a sample`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], "page errors");
});

// ── 200 MiB ────────────────────────────────────────────────────────────────────────────────
const UAS = [
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "UNKNOWN", 50],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "UNKNOWN", 20],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", "DECLARED", 8],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "DECLARED", 8],
  ["python-requests/2.32.3", "SUSPECTED", 6],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36", "SUSPECTED", 4],
  ["-", "SUSPECTED", 4],
];
const ROUTES = [["GET", "/products/"], ["GET", "/blog/post-"], ["GET", "/search?q="], ["POST", "/login"], ["GET", "/cart/"], ["GET", "/static/app."], ["POST", "/api/v1/items/"], ["GET", "/"]];

/** nginx combined lines with fresh IDs (no cache flatters the number); returns what was written. */
function generate(file, bytes) {
  let a = 0x3eb4;
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const total = UAS.reduce((n, u) => n + u[2], 0);
  const counts = { UNKNOWN: 0, DECLARED: 0, SUSPECTED: 0 };
  const fd = fs.openSync(file, "w");
  let written = 0, lines = 0, sec = Date.UTC(2026, 8, 30) / 1000;
  try {
    while (written < bytes) {
      let chunk = "";
      while (chunk.length < 4 << 20) {
        let t = rnd() * total, u = UAS[0];
        for (const x of UAS) if ((t -= x[2]) < 0) { u = x; break; }
        const [m, p] = ROUTES[(rnd() * ROUTES.length) | 0];
        sec += rnd() < 0.3 ? 1 : 0;
        const d = new Date(sec * 1000);
        const two = (n) => String(n).padStart(2, "0");
        const ts = `${two(d.getUTCDate())}/Sep/2026:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
        chunk += `198.${18 + ((rnd() * 2) | 0)}.${(rnd() * 256) | 0}.${1 + ((rnd() * 254) | 0)} - - [${ts}] "${m} ${p}${((rnd() * 1e9) | 0).toString(36)} HTTP/1.1" ${rnd() < 0.9 ? 200 : 404} ${(rnd() * 50000) | 0} "-" "${u[0]}"\n`;
        counts[u[1]]++;
        lines++;
      }
      written += fs.writeSync(fd, chunk);
    }
  } finally { fs.closeSync(fd); }
  return { written, lines, counts };
}

test(`WEB-4: 200 MiB dropped on /scan is read in ≤${LIMIT_S}s, every line counted`, async () => {
  const file = path.join(tmp, "access.log");
  const gen = generate(file, BIG);
  const got = await drop("/scan", [file], { timeout: LIMIT_S * 4 * 1000 });
  const r = got.report;
  assert.equal(r.totals.records, gen.lines, "records");
  assert.equal(r.totals.parsed, gen.lines, "parsed");
  for (const [c, n] of Object.entries(gen.counts)) assert.equal(r.classes[c], n, c);
  assert.equal(r.files[0].format, "combined");
  const s = got.ms / 1000, mbps = gen.written / 1e6 / s;
  console.log(`WEB-4: ${fixtures.length} fixtures + the corpus (en, ja) equal the CLI; ${(gen.written / 1024 ** 2).toFixed(0)} MiB in ${s.toFixed(1)}s (${Math.round(mbps)} MB/s) in headless Chromium`);
  assert.ok(s <= LIMIT_S, `${s.toFixed(1)}s > ${LIMIT_S}s`);
  assert.deepEqual(errors, [], "page errors");
});
