// The rules of the copy check (WEB-2), without a build: the legal line in English and Japanese,
// what counts as a figure, and how a figure is sourced. And a guard on the site's own sources for
// what WEB-2 found on its first run: the Depth table said D3 is "an insured Ballast, offered
// through partners" (保険付きの Ballast、パートナー経由で), which is the line spec §15 draws.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legalLine, quantities, figures, blocks, repoSourceText } from "./copy.mjs";
import { STRINGS } from "../src/scan/strings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "https://github.com/Ludion-ai/Ludion";
const MISSION = `${REPO}/blob/main/docs/MISSION.md`;
const SPEC = `${REPO}/blob/main/docs/ludion-spec.md`;

const CLAIMS = [
  ["Ludion sells insurance for AI agents.", "insurance"],
  ["Every agent is insured by Ballast.", "insurance"],
  ["We partner with underwriters.", "insurance"],
  ["No signup: buy insurance in one click.", "insurance"],
  ["Not only do we verify agents, we insure them.", "insurance"],
  ["D2 plus an insured Ballast, offered through partners when available", "insurance"],
  ["We guarantee payment when an agent breaks something.", "payment guarantee"],
  ["Ludion pays for your losses.", "payment guarantee"],
  ["Refunds within a day.", "payment guarantee"],
  ["Ballast compensates the site.", "payment guarantee"],
  ["The Gate is 100% safe.", "absolute safety"],
  ["Completely secure against bad bots.", "absolute safety"],
  ["The Gate blocks all bad bots.", "absolute safety"],
  ["A risk-free checkpoint.", "absolute safety"],
  ["Your site, bulletproof.", "absolute safety"],
  ["Ludion は AI エージェントの保険を販売します。", "insurance"],
  ["D2 に加えて、保険付きの Ballast（パートナー経由で、提供が始まってから）", "insurance"],
  ["保険を提供し、署名がないエージェントにも対応します。", "insurance"],
  ["エージェントが壊したものは、支払いを保証します。", "payment guarantee"],
  ["損害は Ludion が補償します。", "payment guarantee"],
  ["Gate は100%安全です。", "absolute safety"],
  ["Gate は１００％安全です。", "absolute safety"],
  ["完全に安全なチェックポイント。", "absolute safety"],
  ["すべてのボットを防ぎます。", "absolute safety"],
  ["保険に入らなくても完全に安全です。", "absolute safety"],
];
const DENIALS = [
  "Ballast v0 is not insurance and does not move money.",
  "Ludion does not sell insurance.",
  "Ballast v0 isn't insurance.",
  "Ballast v0 isn’t insurance.",
  "No site is 100% safe.",
  "We never guarantee payment.",
  "This is not a guarantee of payment.",
  "Ballast v0 は保険ではなく、お金も動きません。",
  "Ludion は保険を販売しません。",
  "支払いは保証しません。",
  "100%安全なサイトはありません。",
  "Humans see no difference, and the Gate verifies signatures.",
];

test("copy: the legal line catches claims in English and Japanese, and lets a denial attached to the word through", () => {
  for (const [s, kind] of CLAIMS) {
    const f = legalLine(s);
    assert.ok(f.some((x) => x.kind === kind), `${JSON.stringify(s)}: wanted "${kind}", got ${JSON.stringify(f.map((x) => x.kind))}`);
  }
  for (const s of DENIALS) {
    const stats = {};
    assert.deepEqual(legalLine(s, stats), [], s);
    if (!/no difference/.test(s)) assert.ok(stats.denied >= 1, `${s}: the word was seen and denied`);
  }
});

test("copy: what a figure is, and what is a name", () => {
  const q = (s) => quantities(s).map((x) => [x.value, x.cls]);
  assert.deepEqual(q("HTTP 403 · RFC 9421 · Next.js 16+ · Pressure 0 · depth 0 · D0 · v0 · p99 · §14 · §10.4 · 2026-10-01 · in 2026 · 2026年 · 10月1日 · status below 400 · a 200 without redirects · ed25519 · HTTP/1.1 · DIV-1"), []);
  assert.deepEqual(q("one whose key · one of the files · once · a single busy agent · もう一度 · 唯一の · 十分です · 一人ひとり · 一覧 · 一致"), []);
  const cases = [
    ["a signature lives 60 seconds", [[60, "s"]]],
    ["beyond ±30 seconds of skew", [[30, "s"]]],
    ["within 24 hours", [[24, "h"]]],
    ["at most one hour, within an hour", [[1, "h"], [1, "h"]]],
    ["installs in one line", [[1, "line"]]],
    ["Add two lines to your server", [[2, "line"]]],
    ["the two public files", [[2, "count"]]],
    ["Three minutes is the target", [[3, "min"]]],
    ["99.67% parsed", [[99.67, "%"]]],
    ["1 GiB in 24.4s", [[1, "B"], [24.4, "s"]]],
    ["p99 0.73ms", [[0.73, "ms"]]],
    ["10x faster", [[10, "x"]]],
    ["12,345 requests", [[12345, "count"]]],
    ["trusted by twelve companies", [[12, "count"]]],
    ["about 3", [[3, ""]]],
    ["約3分で", [[3, "min"]]],
    ["最長1時間", [[1, "h"]]],
    ["24時間以内に応答する", [[24, "h"]]],
    ["90日以上の無事故", [[90, "d"]]],
    ["一行で入る", [[1, "line"]]],
    ["三分で", [[3, "min"]]],
    ["書き出された 2 つの公開ファイル", [[2, "count"]]],
    ["寿命は 60 秒", [[60, "s"]]],
    ["３分で", [[3, "min"]]],
    ["100％", [[100, "%"]]],
    ["コード3行以内", [[3, "line"]]],
  ];
  for (const [s, want] of cases) assert.deepEqual(q(s), want, s);
});

// A small page, the way Starlight renders one: a figure in each place a figure can be.
const code = (n) => `<div class="expressive-code"><figure class="frame"><figcaption class="header"><span class="sr-only">Terminal window</span></figcaption><pre data-language="js"><code>${
  Array.from({ length: n }, (_, i) => `<div class="ec-line"><div class="code">line${i}</div></div>`).join("")}</code></pre><div class="copy"><button data-code="x"><div></div></button></div></figure></div>`;
const page = ({ desc = "How to get verified in about three minutes.", intro = `<p>Three minutes is the target (<a href="${MISSION}#m2-diver">DIV-1</a>).</p>`, h2 = "Get verified in 3 minutes", body = "", lines = "two", n = 2 } = {}) =>
  `<!doctype html><html lang="en"><head><title>Page | Ludion</title><meta name="description" content="${desc}"></head><body><main>
  <h1 id="_top">Page</h1><p>HTTP 403 · RFC 9421</p>
  <h2 id="a">${h2}<a class="sl-anchor-link" href="#a"><span class="sr-only">Section titled “${h2}”</span></a></h2>${intro}
  <ol><li><p>A signature lives 60 seconds (<a href="${SPEC}#114-リクエストの署名">spec §11.4</a>). Add ${lines} lines:</p>${code(n)}</li></ol>${body}
  </main></body></html>`;

test("copy: a figure is sourced by a link, in its block, to the repository document that states it, or by the code block it introduces", () => {
  const check = (html) => figures(html, { from: "/t", repoRoot: ROOT });
  const stats = {};
  assert.deepEqual(figures(page(), { from: "/t", repoRoot: ROOT, stats }), []);
  assert.deepEqual(stats, { figures: 5, byRepository: 2, byCode: 1 });
  const bad = (opts, pattern) => {
    const f = check(page(opts));
    assert.ok(f.some((x) => pattern.test(x.what)), `${JSON.stringify(opts)}: wanted ${pattern}, got ${JSON.stringify(f.map((x) => x.what))}`);
  };
  bad({ intro: `<p>Three minutes is the target.</p>` }, /"Three minutes" has no source link in its block/);
  bad({ intro: `<p>Three minutes is the target (<a href="${MISSION}#m1-gate">GATE-3</a>).</p>` }, /is not stated by the repository document it links/);
  bad({ intro: `<p>Three minutes is the target (<a href="/scan">scan</a>).</p>` }, /has no source link in its block/);
  bad({ intro: `<p>Three minutes is the target (<a href="${REPO}/blob/main/docs/NOPE.md">x</a>).</p>` }, /has no source link in its block/);
  bad({ lines: "one" }, /"one lines" counts lines, but the code block after it has 2/);
  bad({ n: 3 }, /"two lines" counts lines, but the code block after it has 3/);
  bad({ h2: "Live in 30 seconds" }, /<h2> "Live in 30 seconds": "30 seconds" is not sourced in its section/);
  bad({ desc: "Verified in 90 seconds." }, /<meta description> .*"90 seconds" is not sourced anywhere on the page/);
  bad({ body: "<table><tr><td>D4</td><td>90 days without incidents</td></tr></table>" }, /<td> "90 days without incidents"/);
  // A heading is sourced only by its own section: the same figure sourced before the heading is not enough.
  const moved = page({ intro: "" }).replace("<h1 id=\"_top\">Page</h1>", `<h1 id="_top">Page</h1><p>Three minutes is the target (<a href="${MISSION}#m2-diver">DIV-1</a>).</p>`);
  assert.deepEqual(check(moved).map((f) => f.what), [`/t: <h2> "Get verified in 3 minutes": "3 minutes" is not sourced in its section`]);
});

test("copy: a repository link reads the file, or the section under the heading its fragment names", () => {
  const section = repoSourceText(`${MISSION}#m2-diver`, ROOT);
  assert.match(section, /^### M2 Diver/);
  assert.match(section, /180秒/);
  assert.doesNotMatch(section, /### M3/, "stops at the next heading of its level");
  assert.match(repoSourceText(`${SPEC}#115-staple状態証明`, ROOT), /最長1時間/);
  assert.match(repoSourceText(encodeURI(`${SPEC}#15-ballast責任`), ROOT), /24時間で応じる/, "a percent-encoded fragment");
  assert.equal(repoSourceText(`${SPEC}#no-such-heading`, ROOT), null);
  assert.equal(repoSourceText("https://example.com/docs/MISSION.md", ROOT), null);
  assert.ok(repoSourceText(`${REPO}/tree/main/packages/gate-node`, ROOT).includes("gate-node"), "a directory reads its README");
});

test("copy: code, anchors and captions are not prose; alt and label texts are read", () => {
  const { blocks: all, attrs, meta } = blocks(`<html><head><title>T 1</title><meta name="description" content="D"></head><body><main>
    <h2>H<a class="sl-anchor-link" href="#h"><span>Section titled “H 5 minutes”</span></a></h2>
    <p>Run <code>sleep 60 seconds</code> now.</p>${code(1)}<img alt="Insured" src="/x.png"><button aria-label="Copy 3 lines">c</button></main></body></html>`);
  const h2 = all.find((b) => b.tag === "h2"), p = all.find((b) => b.tag === "p"), c = all.find((b) => b.tag === "codeblock");
  assert.equal(h2.text, "H");
  assert.equal(p.text.replace(/\s+/g, " "), "Run now.");
  assert.equal(p.code, "sleep 60 seconds");
  assert.deepEqual([c.lines, c.code], [1, "line0"]);
  assert.deepEqual(attrs.map((a) => a.text), ["Insured", "Copy 3 lines"]);
  assert.deepEqual(meta.map((m) => m.text), ["T 1", "D"]);
});

// ── the site's sources ──────────────────────────────────────────────────────────────────────
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (/\.mdx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const strings = (v) => (typeof v === "string" ? [v] : typeof v === "function" ? [String(v(1234, 5678, "12.3%"))] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

test("copy: the site's sources stay on the legal line (pages, partials, the scan's words)", () => {
  const found = [];
  for (const f of files(path.join(ROOT, "site/src"))) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) for (const x of legalLine(line)) found.push(`${path.relative(ROOT, f)}: ${x.what}`);
  }
  for (const s of strings(STRINGS)) for (const x of legalLine(s)) found.push(`site/src/scan/strings.mjs: ${x.what}`);
  assert.deepEqual(found, []);
});
