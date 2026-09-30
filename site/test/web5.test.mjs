// WEB-5 (−): the site has no broken link, no console error, and makes no request outside its
// allowlist, which is its own origin (NIGHT.md §2: no third party, fonts included).
// - Static: every page, stylesheet, script and sitemap of the real build goes through the link
//   check (./links.mjs): links and loads at the site's origin resolve to a shipped file (and a
//   fragment to an id there), nothing loads from another origin, a link into the repository names
//   a path that exists. The URLs a script writes at the site's origin count: the scan's copied
//   text and the daily report link to https://ludion.ai/gate.
// - Live: every page, desktop and mobile, is opened in headless Chromium behind the egress watch
//   (./egress.mjs) and used: the theme switched, the mobile menu and contents opened, the search
//   run, the language switched, a log scanned and its report copied. Console errors, uncaught
//   exceptions, failed requests, responses of 400 and up, and any request the watch refuses are
//   all findings; then the DOM as it stands after the scripts ran goes through the link check too.
// - Out: links that leave the site and the repository are checked on the network. A 404 or 410 is
//   broken; no answer at all leaves them unchecked, and the summary says how many.
// - The check bites: breakage planted in a served page (a dead link, a dead fragment, a font from
//   another origin, a console error, a throw, a missing image, a link added by script, a fetch out,
//   a dead language option, a dead URL in the copied report, a dead path in the repository) must
//   each be caught by the rule meant for it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../build.mjs";
import { launchChromium } from "./browser.mjs";
import { startEgressProxy, judge } from "./egress.mjs";
import { checkSite, checkRefs, checkExternal, extract, publicPath, SITE_URL } from "./links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "accept/fixtures/logs/corpus/nginx-access.log");
const QUIET_MS = 300;
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

let dist, site, proxy, browser;
const external = [];

before(async () => {
  dist = buildSite();
  site = checkSite(dist, { repoRoot: ROOT });
  external.push(...site.external);
  proxy = await startEgressProxy(dist);
  browser = await launchChromium({ proxy: { server: proxy.origin }, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
});
after(async () => {
  await browser?.close();
  await proxy?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── what a visitor does ─────────────────────────────────────────────────────────────────────
/** Switch the theme both ways (every page has the picker). */
async function theme(page) {
  for (const v of ["light", "dark"]) {
    await page.evaluate((v) => {
      const s = document.querySelector("starlight-theme-select select");
      if (s) { s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); }
    }, v);
  }
}
/** On a phone: open the menu and the page's contents, where the page has them. */
async function mobile(page) {
  const menu = page.locator("button.sl-menu-button");
  if (await menu.count() && await menu.first().isVisible()) { await menu.first().click(); await sleep(100); await menu.first().click(); }
  const toc = page.locator("mobile-starlight-toc summary");
  if (await toc.count() && await toc.first().isVisible()) { await toc.first().click(); await sleep(100); await toc.first().click(); }
}
/** Run the search; returns the result links. */
const search = (q) => async (page) => {
  const open = page.locator("site-search button[data-open-modal]");
  await page.waitForFunction(() => !document.querySelector("site-search button[data-open-modal]")?.disabled);
  await open.first().click();
  await page.locator("#starlight__search input").first().fill(q);
  await page.waitForSelector(".pagefind-ui__result-link", { timeout: 30_000 });
  await sleep(QUIET_MS);
  return { results: await page.$$eval(".pagefind-ui__result-link", (as) => as.map((a) => a.getAttribute("href"))) };
};
/** Pick the other language in the picker; the visit follows it to the page it lands on. */
const language = (to) => async (page) => {
  const value = await page.evaluate((to) => [...document.querySelectorAll("starlight-lang-select option")].find((o) => o.textContent.trim() === to)?.value, to);
  assert.ok(value, `a language option "${to}"`);
  await Promise.all([page.waitForURL((u) => u.pathname === value), page.evaluate((value) => {
    const s = document.querySelector("starlight-lang-select select");
    s.value = value; s.dispatchEvent(new Event("change", { bubbles: true }));
  }, value)]);
  await page.waitForLoadState("load");
  return { landed: value };
};
/** Scan a log, then copy the report as text (it carries links too). */
async function scan(page) {
  await page.waitForSelector('.ludion-scan[data-state="idle"]', { state: "attached" });
  await page.setInputFiles("#scan-input", FIXTURE);
  await page.waitForSelector('.ludion-scan[data-state="done"]', { state: "attached", timeout: 60_000 });
  await page.locator(".scan-actions .scan-button").first().click();
  return { copied: await page.evaluate(() => navigator.clipboard.readText()) };
}

/**
 * Open a page, use it, and judge everything seen. `status` is what the document itself must
 * answer (a missing URL: 404); every other response must be below 400.
 */
async function visit(urlPath, { viewport = "desktop", act = null, transform = null, status = 200 } = {}) {
  proxy.seen = [];
  proxy.transform = transform;
  const findings = [], events = [];
  let closing = false;
  // A missing page is answered 404, and Chromium logs that one response as a console error.
  let documentMiss = status === 404 ? 1 : 0;
  const note = (rule, what) => {
    if (closing) return;
    if (rule === "console" && documentMiss && /^Failed to load resource: the server responded with a status of 404\b/.test(what)) { documentMiss--; return; }
    findings.push({ rule, what: `${urlPath} (${viewport}): ${what}` });
  };
  const context = await browser.newContext({ ...VIEWPORTS[viewport] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: proxy.origin });
  context.on("request", (req) => events.push({ source: "browser", method: req.method(), url: req.url(), headers: {}, body: req.postDataBuffer() ?? Buffer.alloc(0) }));
  context.on("requestfailed", (req) => note("failed request", `${req.method()} ${req.url()} (${req.failure()?.errorText})`));
  context.on("response", (res) => {
    const expected = res.request().isNavigationRequest() && new URL(res.url()).pathname === urlPath ? status : null;
    if (expected != null ? res.status() !== expected : res.status() >= 400) note("failed request", `${res.status()} ${res.request().method()} ${res.url()}`);
  });
  context.on("serviceworker", (w) => note("outside", `service worker ${w.url()}`));
  context.on("page", (p) => {
    p.on("console", (m) => { if (m.type() === "error") note("console", m.text()); });
    p.on("pageerror", (e) => note("console", `uncaught: ${e.message}`));
    p.on("websocket", (ws) => note("outside", `websocket ${ws.url()}`));
  });
  const page = await context.newPage();
  let done = {}, html = "", at = urlPath;
  try {
    await page.goto(proxy.origin + urlPath, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await theme(page);
    if (viewport === "mobile") await mobile(page);
    if (act) done = (await act(page)) ?? {};
    await page.waitForLoadState("networkidle");
    await sleep(QUIET_MS);
    at = new URL(page.url()).pathname;
    // The DOM after the scripts ran, with the address it was served at written as the site's own.
    html = (await page.content()).split(proxy.origin).join(new URL(SITE_URL).origin);
  } finally {
    closing = true;
    await context.close();
  }
  const { refs, ids } = extract(html);
  if (done.copied) for (const url of done.copied.match(/https?:\/\/[^\s)"'<>]+/g) ?? []) refs.push({ kind: "link", what: "URL in the copied report", url: url.replace(/[.,;:]+$/, "") });
  const live = checkRefs(refs, { root: dist, from: at, selfIds: ids, repoRoot: ROOT, idsOf: site.idsOf });
  external.push(...live.external);
  // The watch: the site's own origin is the whole allowlist. A query is not the matter here (WEB-6 is),
  // and the missing page asked for on purpose is not a file the site ships, rightly.
  const asked = proxy.origin + urlPath;
  const watched = judge([...proxy.seen, ...events], { origin: proxy.origin, root: dist, canaries: [] })
    .filter((f) => f.rule !== "query" && !(status === 404 && f.rule === "unknown file" && f.what.endsWith(`GET ${asked}`)));
  return {
    findings: [...findings, ...watched.map((f) => ({ ...f, what: `${urlPath} (${viewport}): ${f.what}` })), ...live.findings],
    done, requests: proxy.seen.length, refs: refs.length,
  };
}

// ── the oracle ──────────────────────────────────────────────────────────────────────────────
test("WEB-5: the built site: every link, load, script URL and sitemap entry resolves; nothing loads from another origin", () => {
  assert.ok(site.pages.length >= 28, `pages: ${site.pages.length}`);
  for (const p of ["index.html", "ja.html", "404.html", "ja/404.html", "scan.html", "ja/scan.html", "gate.html", "ja/gate.html"]) assert.ok(site.pages.includes(p), p);
  assert.ok(site.counts.links > 500 && site.counts.loads > 100 && site.counts.sitemap >= site.pages.length - 2, JSON.stringify(site.counts));
  assert.deepEqual(site.findings, []);
});

let liveSummary = "";
test("WEB-5: every page, desktop and mobile, used in Chromium: 0 console errors, 0 failed requests, 0 requests outside the site, every live link resolves", async () => {
  const all = [];
  let visits = 0, requests = 0, refs = 0;
  const run = async (p, opts) => {
    const v = await visit(p, opts);
    all.push(...v.findings);
    visits++; requests += v.requests; refs += v.refs;
    return v;
  };
  for (const rel of site.pages) for (const viewport of Object.keys(VIEWPORTS)) await run(publicPath(rel), { viewport });

  const en = await run("/", { act: search("signature") });
  assert.ok(en.done.results?.length > 0, "the search finds English pages");
  const ja = await run("/ja", { act: search("署名") });
  assert.ok(ja.done.results?.length > 0, "the search finds Japanese pages");
  for (const [from, to] of [["/e/revoked", "日本語"], ["/ja/e/revoked", "English"], ["/404", "日本語"], ["/ja/404", "English"]]) {
    const v = await run(from, { act: language(to) });
    assert.ok(v.done.landed, `${from} → ${to}`);
  }
  for (const p of ["/scan", "/ja/scan"]) {
    const v = await run(p, { act: scan });
    assert.match(v.done.copied ?? "", /UNVERIFIED AUTOMATION ON CRITICAL ROUTES/, `${p}: the report was copied`);
  }
  // A missing page, deep: the 404 page must still load whole there.
  await run("/ja/e/not_a_code/deeper", { status: 404 });

  assert.deepEqual(all, [], "findings");
  liveSummary = `${visits} visits (${site.pages.length} pages × desktop, mobile + search, language, scan, a deep 404): ${requests} requests, all at the site's origin; ${refs} live links resolved`;
});

let outSummary = "";
test("WEB-5: links out answer (a 404 or 410 is broken; no answer leaves a link unchecked, and says so)", async () => {
  const urls = [...new Set(external.map((e) => e.url))];
  const r = await checkExternal(urls);
  const broken = r.filter((x) => x.broken).map((x) => `${x.url} → ${x.status} (from ${external.filter((e) => e.url === x.url).map((e) => e.from).join(", ")})`);
  const unchecked = r.filter((x) => x.status == null || x.status >= 500 || x.status === 429);
  for (const u of unchecked) console.log(`WEB-5 link out not checked: ${u.url} (${u.error ?? u.status})`);
  assert.deepEqual(broken, []);
  outSummary = `${urls.length} links out, ${urls.length - unchecked.length} answered${unchecked.length ? `, ${unchecked.length} unchecked (no answer)` : ""}`;
});

// ── the check bites ─────────────────────────────────────────────────────────────────────────
const into = (file, html) => (rel, bytes) => (rel === file ? Buffer.from(bytes.toString("utf8").replace("</body>", `${html}</body>`)) : bytes);
const swap = (match, from, to) => (rel, bytes) => (match.test(rel) ? Buffer.from(bytes.toString("utf8").split(from).join(to)) : bytes);

const PLANTED = [
  ["a link to a page that is not there", "broken link", "/", into("index.html", '<a href="/e/not_a_code">x</a>')],
  ["a fragment no element has", "broken fragment", "/", into("index.html", '<a href="/e/revoked#no-such-section">x</a>')],
  ["a font stylesheet from another site", "outside", "/", into("index.html", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">')],
  ["a console error", "console", "/", into("index.html", '<script>console.error("planted")</script>')],
  ["an uncaught exception", "console", "/", into("index.html", '<script>throw new Error("planted")</script>')],
  ["an image that is not there", "failed request", "/", into("index.html", '<img src="/_astro/missing.png" alt="">')],
  ["a font file that is not there", "unknown file", "/", into("index.html", '<style>@font-face{font-family:P;src:url(/fonts/missing.woff2)}body{font-family:P}</style>')],
  ["a dead link added by a script", "broken link", "/", into("index.html", '<script>document.body.append(Object.assign(document.createElement("a"), { href: "/nowhere" }))</script>')],
  ["a fetch to another site", "outside", "/", into("index.html", '<script>fetch("http://collect.example/x").catch(() => {})</script>')],
  ["a language option to a page that is not there", "broken link", "/404", swap(/^404\.html$/, 'value="/ja/404.html"', 'value="/ja/nope.html"')],
  ["a dead URL in the copied report", "broken link", "/scan", swap(/^_astro\/.*\.js$/, "https://ludion.ai/gate", "https://ludion.ai/gone")],
  ["a path the repository does not have", "broken link", "/", into("index.html", '<a href="https://github.com/Ludion-ai/Ludion/tree/main/packages/nope">x</a>')],
];

test("WEB-5: the check bites: breakage planted in a served page is caught by its rule", async () => {
  const missed = [];
  for (const [name, rule, at, transform] of PLANTED) {
    const v = await visit(at, { transform, act: at === "/scan" ? scan : null });
    const rules = [...new Set(v.findings.map((f) => f.rule))];
    if (!rules.includes(rule)) missed.push(`${name}: wanted "${rule}", got [${rules.join(", ")}]`);
    console.log(`WEB-5 planted "${name}": caught as ${rules.join(", ") || "nothing"}`);
  }
  assert.deepEqual(missed, [], "planted breakage the check did not catch");
  const s = site.counts;
  console.log(`WEB-5: ${s.pages} pages, ${s.links} links + ${s.loads} loads + ${s.sitemap} sitemap entries resolve, 0 from another origin; ${liveSummary}; ${outSummary}; ${PLANTED.length}/${PLANTED.length} planted breakages caught`);
});
