// The rules of the link check (WEB-5), without a build or a browser; and the source-level guards for
// the broken links WEB-5 found on its first run: the 404 page's Japanese alternate and language
// option pointed at /ja/404, which did not exist, and the scan's copied report, the daily report
// and the Gate's User-Agent all pointed at https://ludion.ai/gate, which did not exist either.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { extract, cssUrls, siteUrlsIn, publicPath, githubSlug, repoLinkProblem, checkRefs, checkSite, checkExternal } from "./links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = "https://ludion.ai";

function tmpSite(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-links-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const rules = (findings) => findings.map((f) => f.rule).sort();

test("links: a page's links and loads are told apart; code, comments and theme options are not links", () => {
  const { refs, ids } = extract(`<!doctype html><html><head>
    <link rel="canonical" href="https://ludion.ai/e"><link rel="alternate" hreflang="ja" href="https://ludion.ai/ja/e">
    <link rel="stylesheet" href="/_astro/a.css"><link rel="shortcut icon" href="/favicon.svg"><link rel="preconnect" href="https://fonts.example">
    <meta property="og:url" content="https://ludion.ai/e"><meta name="description" content="/not/a/link">
    <script>document.querySelector('a[href="/in-code"]')</script><script type="module" src="/_astro/p.js"></script>
    <style>body{background:url("/bg.png")}</style></head><body>
    <!-- <a href="/commented-out"></a> -->
    <a href="/e/revoked#how-to-fix-it" id="x">a</a><a name="old-anchor"></a><h2 id="何が起きたか">h</h2>
    <img src="/i.png" srcset="/i-1x.png 1x, /i-2x.png 2x" alt=""><div style="background-image:url('/d.png')"></div>
    <a href="/q?a=1&amp;b=2">q</a><form action="javascript:void(0);"></form>
    <starlight-theme-select><select><option value="dark">d</option></select></starlight-theme-select>
    <starlight-lang-select><select><option value="/e.html">English</option><option value="/ja/e.html">日本語</option></select></starlight-lang-select>
    </body></html>`);
  const by = (kind) => refs.filter((r) => r.kind === kind).map((r) => r.url).sort();
  assert.deepEqual(by("link"), ["/e.html", "/e/revoked#how-to-fix-it", "/ja/e.html", "/q?a=1&b=2", "https://ludion.ai/e", "https://ludion.ai/e", "https://ludion.ai/ja/e", "javascript:void(0);"].sort());
  assert.deepEqual(by("load"), ["/_astro/a.css", "/_astro/p.js", "/bg.png", "/d.png", "/favicon.svg", "/i-1x.png", "/i-2x.png", "/i.png", "https://fonts.example"].sort());
  assert.deepEqual([...ids].sort(), ["old-anchor", "x", "何が起きたか"].sort());
  assert.deepEqual(cssUrls(`@import "/a.css"; src: url(/f.woff2) format("woff2"), url('data:font/woff2;base64,AA'); x: url( "/b.png" )`), ["/a.css", "/f.woff2", "data:font/woff2;base64,AA", "/b.png"]);
  assert.deepEqual(siteUrlsIn('a="https://ludion.ai/gate",b=`https://ludion.ai/e/${c}`,d="https://ludion.ai.evil.example/x",p="https://ludion.ai:8443/" → https://ludion.ai/scan. (https://ludion.ai)', SITE),
    ["https://ludion.ai/gate", "https://ludion.ai/e/${c}", "https://ludion.ai/scan", "https://ludion.ai"]);
  assert.deepEqual(["index.html", "ja.html", "e/revoked.html", "ja/e/index.html", "404.html"].map(publicPath), ["/", "/ja", "/e/revoked", "/ja/e/", "/404"]);
});

test("links: each rule, on a small built site", () => {
  const root = tmpSite({
    "index.html": '<h1 id="_top">t</h1>', "e.html": '<h2 id="what-happened">w</h2>', "e/revoked.html": '<h2 id="how-to-fix-it">h</h2>',
    "ja.html": "", "favicon.svg": "", "_astro/a.css": "",
  });
  try {
    const idsOf = (f) => extract(fs.readFileSync(f, "utf8")).ids;
    const check = (url, kind = "link", from = "/e", selfIds = new Set(["here"])) => checkRefs([{ kind, what: "t", url }], { root, from, selfIds, repoRoot: ROOT, idsOf });
    const ok = (url, kind) => assert.deepEqual(check(url, kind).findings, [], url);
    const bad = (url, rule, kind) => assert.deepEqual(rules(check(url, kind).findings), [rule], url);

    for (const u of ["/", "/e", "e/revoked", "/e/revoked.html", "/e/revoked#how-to-fix-it", "https://ludion.ai/ja", "#here", "#top", "#", "/e#what-happened",
      "mailto:hello@ludion.ai", "javascript:void(0);", "javascript:;", "/?q=1"]) ok(u);
    for (const u of ["/favicon.svg", "/_astro/a.css", "data:image/png;base64,AA", "blob:https://ludion.ai/1"]) ok(u, "load");
    bad("/e/not_a_code", "broken link");
    bad("https://ludion.ai/ja/404", "broken link");
    bad("/../../etc/passwd", "broken link");
    bad("javascript:alert(1)", "broken link");
    bad("/_astro/missing.js", "broken load", "load");
    bad("/e/revoked#no-such-section", "broken fragment");
    bad("#elsewhere", "broken fragment");
    bad("https://fonts.googleapis.com/css2?family=Inter", "loads from another origin", "load");
    bad("//cdn.example/x.js", "loads from another origin", "load");
    bad("ftp://example.com/x", "broken link");
    // Links out are not judged here, only handed on.
    assert.deepEqual(check("https://datatracker.ietf.org/doc/x/").external.map((e) => e.url), ["https://datatracker.ietf.org/doc/x/"]);
    // Links into the repository are judged against this checkout.
    ok("https://github.com/Ludion-ai/Ludion");
    ok("https://github.com/Ludion-ai/Ludion/tree/main/packages/gate-node");
    ok("https://github.com/Ludion-ai/Ludion/blob/main/packages/gate-node/README.md#configuration");
    ok("https://github.com/Ludion-ai/Ludion/tree/main/packages/gate-node#readme");
    bad("https://github.com/Ludion-ai/Ludion/tree/main/packages/nope", "broken link");
    bad("https://github.com/Ludion-ai/Ludion/blob/main/packages/gate-node/README.md#no-such-heading", "broken link");
    bad("https://github.com/Ludion-ai/Ludion/tree/some-branch/packages", "broken link");
    assert.equal(check("https://github.com/Ludion-ai/Ludion").external.length, 0);
    assert.equal(check("https://github.com/Ludion-ai/Ludion-other").external.length, 1, "another repository is a link out");
    assert.equal(githubSlug("Install (60 seconds)"), "install-60-seconds");
    assert.equal(githubSlug("`@ludion/gate-node` config"), "ludiongate-node-config");
    assert.match(repoLinkProblem("https://github.com/Ludion-ai/Ludion/tree/main/packages/gate-core/src#readme", ROOT) ?? "", /no README/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("links: a whole site: stylesheets, scripts at the site's origin, and the sitemap are checked too", () => {
  const clean = {
    "index.html": '<link rel="stylesheet" href="/_astro/a.css"><script src="/_astro/p.js"></script><a href="/scan">s</a>',
    "scan.html": "", "gate.html": "", "_astro/a.css": "body{background:url(../bg.png)}", "bg.png": "",
    "_astro/p.js": 'const u="https://ludion.ai/gate"', "sitemap-0.xml": "<urlset><url><loc>https://ludion.ai/scan</loc></url></urlset>",
  };
  let root = tmpSite(clean);
  try {
    const r = checkSite(root, { site: SITE, repoRoot: ROOT });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.counts, { pages: 3, links: 2, loads: 3, scripts: 1, stylesheets: 1, sitemap: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  root = tmpSite({ ...clean, "_astro/a.css": "body{background:url(/nope.png)}", "_astro/p.js": 'const u="https://ludion.ai/gone"',
    "sitemap-0.xml": "<urlset><url><loc>https://ludion.ai/nope</loc></url></urlset>" });
  try {
    assert.deepEqual(rules(checkSite(root, { site: SITE, repoRoot: ROOT }).findings), ["broken link", "broken link", "broken load"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("links: a link out is broken on 404 or 410, answered otherwise, and unchecked when nothing answers", async () => {
  const server = http.createServer((req, res) => {
    const status = { "/ok": 200, "/gone": 410, "/missing": 404, "/down": 503 }[req.url] ?? (req.method === "HEAD" ? 405 : 200);
    res.writeHead(status).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const closed = `http://127.0.0.1:${dead.address().port}/`;
  await new Promise((r) => dead.close(r));
  try {
    const r = Object.fromEntries((await checkExternal([`${base}/ok`, `${base}/gone`, `${base}/missing`, `${base}/down`, `${base}/head-refused`, closed], { timeoutMs: 5000 }))
      .map((x) => [x.url.replace(base, ""), x]));
    assert.equal(r["/ok"].broken, false);
    assert.equal(r["/gone"].broken, true);
    assert.equal(r["/missing"].broken, true);
    assert.deepEqual([r["/down"].status, r["/down"].broken], [503, false]);
    assert.deepEqual([r["/head-refused"].status, r["/head-refused"].broken], [200, false], "HEAD refused: asked again with GET");
    assert.deepEqual([r[closed].status, r[closed].broken], [null, false]);
    assert.ok(r[closed].error);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

// ── the site's sources ──────────────────────────────────────────────────────────────────────
const DOCS = path.join(ROOT, "site/src/content/docs");
const hasPage = (p) => ["", "/index"].some((i) => [".md", ".mdx"].some((x) => fs.existsSync(path.join(DOCS, `${p}${i}${x}`))));

test("links: every https://ludion.ai/ URL the code hands out has a page, in English and Japanese", () => {
  const seen = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "test", "dist", ".astro"].includes(e.name) || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|ts|astro|mdx?)$/.test(e.name)) for (const u of siteUrlsIn(fs.readFileSync(p, "utf8"), SITE)) seen.set(u, path.relative(ROOT, p));
    }
  };
  for (const d of ["packages", "services", "site/src"]) walk(path.join(ROOT, d));
  assert.ok(seen.has("https://ludion.ai/gate"), "the scan, the report and the Gate's User-Agent link to /gate");
  for (const [url, file] of seen) {
    // A templated /e/<code>: WEB-3 checks every code; here, the index they sit under.
    const p = new URL(url.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "CODE")).pathname.replace(/\/CODE$/, "").replace(/^\/|\/$/g, "");
    for (const lang of ["", "ja"]) {
      const id = [lang, p].filter(Boolean).join("/") || "index";
      assert.ok(hasPage(id), `${url} (in ${file}) has no page: site/src/content/docs/${id}.mdx`);
    }
  }
});

test("links: every locale has its own 404 page (Starlight's 404 has no fallback: the language picker would point nowhere)", () => {
  const config = fs.readFileSync(path.join(ROOT, "site/astro.config.mjs"), "utf8");
  const locales = [...config.matchAll(/^\s*([a-z]{2}(?:-[A-Z]{2})?): \{ label:/gm)].map((m) => m[1]);
  assert.ok(locales.includes("ja"), `locales: ${locales}`);
  for (const l of locales) assert.ok(hasPage(`${l}/404`), `site/src/content/docs/${l}/404.mdx`);
});
