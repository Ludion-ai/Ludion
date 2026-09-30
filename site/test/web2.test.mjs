// WEB-2 (−): the site's copy stays on the legal line of spec §14 and §21, and every figure on it
// has its source. The rules are in ./copy.mjs; this runs them on the real build.
// - The legal line: no page, title, description, alt or label text says that Ludion sells or
//   brokers insurance, guarantees a payment, or promises absolute safety, in English or Japanese;
//   a word on that line appears only where it is denied. The words the scan writes in the browser
//   (its page strings) and the report it copies (the CLI's text, on a real log) are held to it too.
// - Figures: every quantity on every page links, in its block, to the repository document or
//   heading section that states it, or is the length of the code block it introduces; a figure
//   in a heading is sourced in its section, one in the title or description on the page. The
//   numbers the scan computes come from the visitor's own log (WEB-4 holds them equal to the CLI).
// - The check bites: claims and unsourced figures planted in built pages are caught by their
//   rule, and a denial, a sourced figure and a name planted the same way are not.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan, renderText } from "@ludion/scan";
import { buildSite } from "../build.mjs";
import { filesOf, publicPath } from "./links.mjs";
import { legalLine, legalLineOfPage, figures } from "./copy.mjs";
import { STRINGS } from "../src/scan/strings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = path.join(ROOT, "accept/fixtures/logs/corpus");
const MISSION = "https://github.com/Ludion-ai/Ludion/blob/main/docs/MISSION.md";
const SPEC = "https://github.com/Ludion-ai/Ludion/blob/main/docs/ludion-spec.md";

let pages;
before(() => {
  const dist = buildSite();
  pages = filesOf(dist).filter((f) => f.endsWith(".html")).map((f) => ({ file: f, from: publicPath(f), html: fs.readFileSync(path.join(dist, f), "utf8") }));
});

const check = (p, stats = {}) => [...legalLineOfPage(p.html, { from: p.from, stats }), ...figures(p.html, { from: p.from, repoRoot: ROOT, stats })];

let legalSummary = "", figureSummary = "", scanSummary = "";
test("WEB-2: every page: nothing sells insurance, guarantees a payment or promises absolute safety (English and Japanese)", () => {
  assert.ok(pages.length >= 28, `pages: ${pages.length}`);
  const stats = {};
  const found = pages.flatMap((p) => legalLineOfPage(p.html, { from: p.from, stats }));
  assert.deepEqual(found, []);
  // The words are read, not missed: the pages deny insurance in both languages, and those denials are seen.
  const en = pages.find((p) => p.from === "/e/ballast_required"), ja = pages.find((p) => p.from === "/ja/e/ballast_required");
  for (const p of [en, ja]) {
    const s = {};
    legalLineOfPage(p.html, { from: p.from, stats: s });
    assert.ok(s.denied >= 1, `${p.from}: the denial of insurance is seen`);
  }
  legalSummary = `${pages.length} pages, ${stats.runs} runs of text on the legal line (${stats.denied} denials let through)`;
});

test("WEB-2: the words the scan writes, and the report it copies, stay on the legal line", async () => {
  const strings = (v) => (typeof v === "string" ? [v] : typeof v === "function" ? [String(v(1234, 5678, "12.3%"))] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  const words = strings(STRINGS);
  assert.ok(words.length >= 80, `scan strings: ${words.length}`);
  const report = renderText(await scan([CORPUS]));
  assert.match(report, /UNVERIFIED AUTOMATION ON CRITICAL ROUTES/);
  const found = [...words, ...report.split("\n")].flatMap((s) => legalLine(s));
  assert.deepEqual(found, []);
  scanSummary = `${words.length} scan strings and a ${report.split("\n").length}-line report clean`;
});

test("WEB-2: every figure on every page links the repository document that states it, or is the length of the code block it introduces", () => {
  const stats = {};
  const found = pages.flatMap((p) => figures(p.html, { from: p.from, repoRoot: ROOT, stats }));
  assert.deepEqual(found, []);
  assert.ok(stats.figures >= 60 && stats.byRepository >= 20 && stats.byCode >= 4, `the check saw figures: ${JSON.stringify(stats)}`);
  figureSummary = `${stats.figures} figures, all sourced (${stats.byRepository} in blocks by the repository, ${stats.byCode} by their code block, the rest in headings and descriptions)`;
});

// ── the check bites ─────────────────────────────────────────────────────────────────────────
const into = (html) => (page) => page.replace("</main>", `${html}</main>`);
const swap = (from, to) => (page) => { assert.ok(page.includes(from), `the plant lands: ${from}`); return page.split(from).join(to); };

const PLANTED = [
  ["sells insurance", "legal line", "/", into("<p>Ludion sells insurance for AI agents.</p>")],
  ["insurance through partners (ja)", "legal line", "/ja/e/depth_insufficient", swap("Ballast v1（Ludion はまだ提供していません）", "保険付きの Ballast（パートナー経由で、提供が始まってから）")],
  ["an insured Ballast (the first finding)", "legal line", "/e/depth_insufficient", swap("Ballast v1, which Ludion does not offer yet", "an insured Ballast, offered through partners when available")],
  ["guarantees payment", "legal line", "/e/ballast_required", into("<p>We guarantee payment if an agent breaks something.</p>")],
  ["支払いを保証 (ja)", "legal line", "/ja/e/ballast_required", into("<p>エージェントが壊したものの支払いを保証します。</p>")],
  ["100% safe", "legal line", "/gate", into("<p>The Gate makes your site 100% safe.</p>")],
  ["100%安全 (ja)", "legal line", "/ja/gate", into("<p>Gate を入れれば100%安全です。</p>")],
  ["すべてのボットを防ぐ (ja)", "legal line", "/ja", into("<p>すべてのボットを防ぎます。</p>")],
  ["a denial not attached to the word", "legal line", "/", into("<p>No signup: buy insurance in one click.</p>")],
  ["a claim in the description", "legal line", "/gate", swap('content="Install the Ludion Gate', 'content="Fully secure. Install the Ludion Gate')],
  ["a claim in an image's alt text", "legal line", "/scan", into('<img src="/favicon.svg" alt="Insured by Ludion">')],
  ["an unsourced percentage", "unsourced figure", "/", into("<p>The Gate stops 99.7% of bad bots.</p>")],
  ["an unsourced figure (ja)", "unsourced figure", "/ja", into("<p>導入は5分で終わります。</p>")],
  ["a figure spelled out", "unsourced figure", "/", into("<p>Trusted by twelve companies.</p>")],
  ["a figure its link does not state", "unsourced figure", "/gate", into(`<p>Verified in 5 minutes (<a href="${MISSION}#m2-diver">DIV-1</a>).</p>`)],
  ["a figure linked to a page of the site, not a source", "unsourced figure", "/", into('<p><a href="/scan">10x more agents</a> than last year.</p>')],
  ["a line count the code block does not have", "unsourced figure", "/gate", swap("Add two lines to your server", "Add one line to your server")],
  ["a line count the code block does not have (ja)", "unsourced figure", "/ja/gate", swap("サーバに2行を足します", "サーバに1行を足します")],
  ["a heading its section does not source", "unsourced figure", "/e/revoked", into("<h2>Live in 30 seconds</h2><p>Soon.</p>")],
  ["a figure in the description", "unsourced figure", "/e/revoked", swap("about three minutes", "about 90 seconds")],
  ["a sourced figure's link removed", "unsourced figure", "/e/staple_expired", swap(`<a href="${encodeURI(`${SPEC}#105-staple状態証明`)}">spec §10.5</a>`, "spec §10.5")],
];
const CONTROLS = [
  ["a denial", "/", into("<p>Ballast v0 is not insurance, and Ludion does not sell insurance.</p>")],
  ["a denial (ja)", "/ja", into("<p>Ballast v0 は保険ではなく、Ludion は保険を販売しません。</p>")],
  ["a sourced figure", "/", into(`<p>A Staple lives at most 1 hour (<a href="${SPEC}#105-staple状態証明">spec §10.5</a>).</p>`)],
  ["a sourced figure (ja)", "/ja", into(`<p>苦情には24時間以内に応答します（<a href="${SPEC}#14-ballast責任">仕様 §14</a>）。</p>`)],
  ["names, not figures", "/", into("<p>HTTP 429, RFC 9421, Next.js 16, Pressure 2, D3, §10.4, 2026-10-01.</p>")],
];

test("WEB-2: the check bites: planted claims and unsourced figures are caught by their rule; denials, sourced figures and names are not", () => {
  const byPath = new Map(pages.map((p) => [p.from, p]));
  const missed = [];
  for (const [name, rule, at, transform] of PLANTED) {
    const p = byPath.get(at);
    assert.ok(p, at);
    const rules = [...new Set(check({ ...p, html: transform(p.html) }).map((f) => f.rule))];
    if (!rules.includes(rule)) missed.push(`${name}: wanted "${rule}", got [${rules.join(", ")}]`);
    console.log(`WEB-2 planted "${name}": caught as ${rules.join(", ") || "nothing"}`);
  }
  assert.deepEqual(missed, [], "planted copy the check did not catch");
  for (const [name, at, transform] of CONTROLS) {
    const p = byPath.get(at);
    assert.deepEqual(check({ ...p, html: transform(p.html) }).map((f) => f.what), [], `control "${name}" is not a finding`);
  }
  console.log(`WEB-2: ${legalSummary}; ${scanSummary}; ${figureSummary}; ${PLANTED.length}/${PLANTED.length} planted caught, ${CONTROLS.length}/${CONTROLS.length} controls clean`);
});
