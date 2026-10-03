// The copy check for the site oracle WEB-2. It reads text and markup, never a browser.
// Rule 1, the legal line (spec §15, §22): no text says that Ludion sells or brokers insurance,
//   guarantees a payment, or promises absolute safety. A word on that line may appear only where
//   it is denied ("Ballast v0 is not insurance"), and the denial must be attached to that word:
//   in English a negator a few words before it in the same clause, in Japanese a negative
//   predicate after it in the same clause, before any positive one.
// Rule 2, figures have sources: a quantity written in a block of the page (a paragraph, a list
//   item, a table cell) comes with a link, in that block, into the repository, to a document or
//   heading section that states the same quantity (value and unit). A count of lines may instead
//   be sourced by the code block it introduces, which must have exactly that many lines. A figure
//   in a heading is sourced when its section carries it sourced; one in the title, the h1 or the
//   description, when the page does.
// What a quantity is (and what is a name, like HTTP 403 or RFC 9421) is defined by quantities().
import fs from "node:fs";
import path from "node:path";
import { REPO_URL, githubSlug, unescapeHtml } from "./links.mjs";

// ── rule 1: the legal line ─────────────────────────────────────────────────────────────────
const EN_TERMS = [
  ["insurance", /\b(?:re)?insur(?:e|es|ed|er|ers|ing|ance|ances|able)\b|\bunderwrit\w*/gi],
  ["payment guarantee", /\bguarant(?:y|ies|ee|ees|eed|eeing)\b|\bwarrant(?:y|ies)\b|\b(?:indemni|compensat|reimburs|refund)\w*|\bpayouts?\b/gi],
  ["payment guarantee", /\b(?:we|ludion|ballast|the\s+registry|the\s+gate)\s+(?:will\s+)?pays?\b|\bpay(?:s|ing)?\s+(?:out|you\s+back|for\s+(?:the\s+|any\s+|your\s+)?(?:loss|losses|damage|damages))\b/gi],
  ["absolute safety", /\b(?:completely|fully|totally|perfectly|absolutely|entirely|always|guaranteed|provably)\s+(?:safe|secure|protected|bot-?proof)\b/gi],
  ["absolute safety", /\b(?:unhackable|unbreakable|bullet-?proof|fool-?proof|tamper-?proof|risk-?free|zero[-\s]risk|no[-\s]risk)\b/gi],
  ["absolute safety", /\b(?:blocks?|stops?|prevents?|catch(?:es)?|eliminates?|defeats?)\s+(?:all|every|any)\b/gi],
];
const JA_TERMS = [
  ["insurance", /保険/g],
  ["payment guarantee", /保証|補償|賠償|弁済|補填|返金|払い戻|肩代わり|代わりに(?:支)?払|支払いを約束/g],
  ["absolute safety", /完全に安全|完全な安全|絶対(?:に)?安全|安全を(?:約束|保証)|万全|リスク(?:は)?ゼロ|ゼロリスク|(?:確実|必ず|完全)に?(?:防|止め|守|遮断|ブロック)|(?:すべて|全て|あらゆる)の(?:ボット|エージェント|攻撃|不正|自動化)を(?:防|止め|遮断|ブロック)/g],
];
// Written the same in both languages ("100%安全", "100% safe"): denied in either counts.
const BOTH_TERMS = [["absolute safety", /\b100\s*(?:%|percent\b|パーセント)|\bhundred\s+percent\b|百パーセント/gi]];
const EN_NEGATOR = /^(?:not|no|never|nor|neither|without|cannot|none|nothing|nobody|\w+n['’]t)$/i;
const NOT_A_DENIAL = /^(?:only|just|merely|but|doubt|wonder)$/i; // "not only", "no doubt", "nothing but"
const EN_CLAUSE_BREAK = /[,;:()[\]{}—–!?.\n]/;
const JA_CLAUSE_END = /[、。！？!?\n,;:；：（）()「」『』[\]]/;
const JA_NEG = /ではなく|ではない|ではありません|じゃな[いく]|でな[いく]|でもな[いく]|ません|な[いく]|なし|無し|せず|ず(?=$|[にともの、。])/;
const JA_POS = /ます|です|でした|する|した|できる|である|だ$/;

/** Whether the English term at `at` in `text` is denied: a negator in the last words before it, same clause. */
function deniedEn(text, at) {
  const before = text.slice(0, at);
  const clause = before.slice(Math.max(...[...before.matchAll(new RegExp(EN_CLAUSE_BREAK, "g"))].map((m) => m.index + 1), 0));
  const words = clause.trim().split(/\s+/).filter(Boolean).slice(-6);
  return words.some((w, i) => EN_NEGATOR.test(w) && !NOT_A_DENIAL.test(words[i + 1] ?? ""));
}
/** Whether the Japanese term ending at `end` is denied: the first predicate after it, same clause, is negative. */
function deniedJa(text, end) {
  const rest = text.slice(end, end + 30);
  const clause = rest.slice(0, rest.search(JA_CLAUSE_END) < 0 ? rest.length : rest.search(JA_CLAUSE_END));
  const neg = clause.search(JA_NEG), pos = clause.search(JA_POS);
  return neg >= 0 && (pos < 0 || neg < pos);
}

/**
 * Legal-line findings in one run of text: [{ rule, kind, what }]. `stats.denied` counts the words
 * on the line that were let through because they are denied.
 */
export function legalLine(text, stats = {}) {
  const t = text.normalize("NFKC");
  const out = [];
  const flag = (kind, m) => out.push({ rule: "legal line", kind, what: `${kind}: "${t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " ").trim()}"` });
  const judge = (kind, m, denied) => { if (denied) stats.denied = (stats.denied ?? 0) + 1; else flag(kind, m); };
  for (const [kind, re] of EN_TERMS) for (const m of t.matchAll(re)) judge(kind, m, deniedEn(t, m.index));
  for (const [kind, re] of JA_TERMS) for (const m of t.matchAll(re)) judge(kind, m, deniedJa(t, m.index + m[0].length));
  for (const [kind, re] of BOTH_TERMS) for (const m of t.matchAll(re)) judge(kind, m, deniedEn(t, m.index) || deniedJa(t, m.index + m[0].length));
  return out;
}

// ── rule 2: what a quantity is ─────────────────────────────────────────────────────────────
// A figure (digits, or a number word with a unit) is a quantity when it has a unit, when it is
// big or precise (four digits or more, a decimal, a thousands separator), or when a comparator
// qualifies it (±, ≤, about, up to, 約, 最長 …). It is a name, not a quantity, when it is part
// of a token (D0, v0, p99, ed25519, HTTP/1.1, 2026-10-01), follows a naming word (RFC 9421,
// HTTP 403, Next.js 16, Pressure 0, §14), or is a year (2026, 2026年) or a date (10月1日).
const UNITS = [
  ["%", String.raw`%|percent\b|パーセント`],
  ["ms", String.raw`ms\b|milliseconds?\b|ミリ秒`],
  ["s", String.raw`s\b|secs?\b|seconds?\b|秒`],
  ["min", String.raw`mins?\b|minutes?\b|分(?![のけかる野析類割散離布])`],
  ["h", String.raw`h\b|hrs?\b|hours?\b|時間`],
  ["d", String.raw`days?\b|日間?`],
  ["w", String.raw`weeks?\b|週間?`],
  ["mo", String.raw`months?\b|か月|ヶ月|カ月|ケ月`],
  ["y", String.raw`years?\b|年間?`],
  ["line", String.raw`lines?\b|行(?![うっいきかけくこ動為政])`],
  ["x", String.raw`x\b|×|times\b|fold\b|倍`],
  ["B", String.raw`[KMGTP]i?B\b|bytes?\b|バイト`],
  ["count", String.raw`(?:requests?|agents?|sites?|bots?|users?|customers?|compan(?:y|ies)|files?|events?|attacks?|signatures?|keys?|pages?|codes?|languages?|operators?|visits?|quer(?:y|ies)|steps?|commands?|routes?|errors?|people|persons?|countries|ecosystems?|runtimes?|formats?|domains?|rows?|records?|entries|entry|members?)\b|件|社|人|名|回|つ|個|本|台|か所|箇所|種類?|形式|言語|ページ|ドメイン|サイト`],
];
const UNIT_RE = new RegExp(`^(?:${UNITS.map(([, r]) => `(${r})`).join("|")})`, "i");
const unitOf = (s) => { const m = UNIT_RE.exec(s); if (!m) return null; const i = m.slice(1).findIndex((g) => g != null); return { cls: UNITS[i][0], len: m[0].length }; };
const NAMING = /(?:\bRFC|\bHTTP|\bstatus|§|\bADR-?|\bversion|\bdraft|\bNext\.js|\bNode(?:\.js)?|\bDeno|\bBun|\bPython|\bPHP|\bGo|\bPressure|\bDepth|\bPhase|\bLevel|\bport|\bTLS|\bNo\.|#|\bStep|\bM|\bQ|\bP|\bD|\bL)\s?$/i;
const COMPARATOR = /(?:[±≤≥<>~≒]|約|最長|最大|最短|最低|およそ|\babout|\baround|\bover|\bunder|\bup to|\bmore than|\bless than|\bfewer than|\bat least|\bat most|\bwithin|\bnearly|\balmost|\bonly|\bapproximately)\s?$/i;
// A word that cannot stand between a number and what it counts ("one whose key", "two of the files").
const FUNCTION_WORD = /^(?:of|in|to|and|or|at|on|per|for|by|with|from|than|as|is|are|was|were|be|the|a|an|this|that|these|those|which|who|whom|whose|what|more|less|such|other|another)$/i;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100, thousand: 1000, dozen: 12 };
const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiValue(s) {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in KANJI) cur = KANJI[ch];
    else { const mul = { 十: 10, 百: 100, 千: 1000, 万: 10000 }[ch]; total += (cur || 1) * mul; cur = 0; }
  }
  return total + cur;
}

/** Every quantity in a run of text: [{ value, cls, raw, index }]. */
export function quantities(text) {
  const t = text.normalize("NFKC");
  const out = [];
  const push = (value, cls, index, len) => out.push({ value, cls, raw: t.slice(index, index + len), index });
  // Digits.
  for (const m of t.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)) {
    const before = t.slice(Math.max(0, m.index - 16), m.index), after = t.slice(m.index + m[0].length);
    if (/[\w.\-/@:$\\]$/.test(before)) continue;                                  // part of a token
    if (/^(?:\.\d|[-/:]\d)/.test(after) || (/^[A-Za-z_]/.test(after) && !unitOf(after))) continue;
    if (NAMING.test(before)) continue;
    const value = Number(m[0].replace(/,/g, ""));
    if (/^\d{4}$/.test(m[0]) && value >= 1900 && value <= 2099 && !/^\s?(?:年間|years?\b)/.test(after)) continue; // a year
    if (/^(?:月|\/\d)/.test(after) || /月\s?$/.test(before)) continue;                // a date
    const gap = /^\s?/.exec(after)[0].length;
    let u = unitOf(after.slice(gap));
    let len = m[0].length + (u ? gap + u.len : 0);
    if (!u) { // one word between a number and its unit: "2 public files"
      const w = /^\s(\p{L}[\p{L}-]*)\s/u.exec(after);
      const u2 = w && !FUNCTION_WORD.test(w[1]) ? unitOf(after.slice(w[0].length)) : null;
      if (u2?.cls === "count") { u = u2; len = m[0].length + w[0].length + u2.len; }
    }
    const big = /\d{4}|[.,]/.test(m[0]);
    if (u || big || COMPARATOR.test(before)) push(value, u?.cls ?? "", m.index, len);
  }
  // Number words with a unit: "three minutes", "one line", "two public files".
  for (const m of t.matchAll(new RegExp(String.raw`\b(${Object.keys(WORDS).join("|")})\s+`, "gi"))) {
    const rest = t.slice(m.index + m[0].length);
    let u = unitOf(rest), len = m[0].length;
    if (!u) {
      const w = /^(\p{L}[\p{L}-]*)\s+/u.exec(rest);
      const u2 = w && !FUNCTION_WORD.test(w[1]) ? unitOf(rest.slice(w[0].length)) : null;
      if (u2?.cls === "count") { u = u2; len += w[0].length; }
    }
    if (u) push(WORDS[m[1].toLowerCase()], u.cls, m.index, len + u.len);
  }
  // "an hour", "a day": one of a unit of time.
  for (const m of t.matchAll(/\ban?\s+(?=(?:minute|hour|day|week|month|year)\b)/gi)) {
    const u = unitOf(t.slice(m.index + m[0].length));
    push(1, u.cls, m.index, m[0].length + u.len);
  }
  // Kanji numerals with a counter: 一行、三分、二つ (not 十分 "enough", 一人ひとり "each").
  for (const m of t.matchAll(/[一二三四五六七八九十百千万]+/g)) {
    const after = t.slice(m.index + m[0].length);
    if (/[\p{Script=Han}]$/u.test(t.slice(0, m.index)) && !/[約最]$/.test(t.slice(0, m.index))) continue;
    if ((m[0] === "十" && /^分/.test(after)) || /^人(?:ひとり|一人)/.test(after)) continue;
    const u = unitOf(after);
    if (u && u.cls !== "%") push(kanjiValue(m[0]), u.cls, m.index, m[0].length + u.len);
  }
  return out.sort((a, b) => a.index - b.index);
}
const same = (a, b) => a.value === b.value && a.cls === b.cls;
const show = (q) => `"${q.raw}"`;

// ── markup: blocks, links, code ────────────────────────────────────────────────────────────
const BLOCK = new Set(["html", "body", "main", "header", "footer", "nav", "aside", "section", "article", "div", "p", "li", "ul", "ol", "table", "tr",
  "td", "th", "dd", "dt", "dl", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "figcaption", "caption", "summary", "details", "blockquote", "label", "button", "option", "select", "legend", "form", "dialog"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DROP = new Set(["script", "style", "template", "svg", "math"]);
const CODE = new Set(["pre", "code", "kbd", "samp", "var"]);

/**
 * A page as blocks, in document order: { tag, level, text, code, links, inMain, start, end }.
 * `text` is prose (code left out), `code` is code text; `links` are the hrefs of the block's own
 * links. Code blocks (a <pre>, or an Expressive Code frame) are { tag: "codeblock", lines, start }.
 * Starlight's heading anchors ("Section titled …") are not text. `meta` holds the title and the
 * descriptions; `attrs` the alt, title, aria-label and placeholder texts.
 */
export function blocks(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const out = [], stack = [], meta = [], attrs = [];
  let root = { tag: "#root", level: 0, text: "", code: "", links: [], inMain: false, start: 0, end: src.length };
  let drop = 0, code = 0, anchor = 0, frame = null;
  const cur = () => stack.findLast((s) => s.block) ?? { block: root };
  for (const t of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    const [raw, close, rawName, rawAttrs, textRun] = t;
    if (textRun != null) {
      if (drop || anchor) continue;
      const s = unescapeHtml(textRun);
      if (frame) { if (frame.ec.length) frame.ec[frame.ec.length - 1] += s; frame.text += s; continue; }
      const b = cur().block;
      if (code) b.code += s; else b.text += s;
      continue;
    }
    const name = rawName.toLowerCase();
    const a = {};
    for (const m of rawAttrs.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) a[m[1].toLowerCase()] = unescapeHtml(m[2] ?? m[3] ?? m[4] ?? "");
    if (!close) {
      if (name === "title" && !drop) { const e = src.indexOf("</title>", t.index); meta.push({ what: "<title>", text: unescapeHtml(src.slice(t.index + raw.length, e)) }); }
      if (name === "meta" && /^(?:description|og:description|twitter:description|og:title|twitter:title)$/i.test(a.name ?? a.property ?? "")) meta.push({ what: `<meta ${a.name ?? a.property}>`, text: a.content ?? "" });
      for (const k of ["alt", "title", "aria-label", "placeholder"]) if (a[k] && !drop) attrs.push({ what: `${name}[${k}]`, text: a[k] });
    }
    if (VOID.has(name)) { if (name === "br" && !drop) cur().block[code ? "code" : "text"] += "\n"; continue; }
    if (close) {
      const i = stack.findLastIndex((s) => s.name === name);
      if (i < 0) continue;
      for (const s of stack.splice(i)) {
        if (DROP.has(s.name)) drop--;
        if (s.code) code--;
        if (s.anchor) anchor--;
        if (s.frame) {
          // Lines of code that are not blank: Expressive Code's rendered lines, or a plain <pre>'s.
          frame.lines = (frame.ec.length ? frame.ec : frame.text.split("\n")).filter((l) => l.trim()).length;
          frame.code = frame.text;
          delete frame.ec; delete frame.text;
          frame = null;
        }
        if (s.block) s.block.end = t.index;
      }
      continue;
    }
    const s = { name };
    stack.push(s);
    if (DROP.has(name)) { drop++; continue; }
    if (drop) continue;
    if (name === "a" && /\bsl-anchor-link\b/.test(a.class ?? "")) { s.anchor = true; anchor++; continue; }
    if (frame) {
      if (/\bec-line\b/.test(a.class ?? "")) frame.ec.push("");
      // The frame's caption ("Terminal window") and copy button are not code.
      if (name === "figcaption" || (name === "div" && /\bcopy\b/.test(a.class ?? ""))) { s.anchor = true; anchor++; }
      continue;
    }
    if (name === "pre" || (name === "div" && /\bexpressive-code\b/.test(a.class ?? ""))) {
      frame = { tag: "codeblock", lines: 0, ec: [], text: "", start: t.index, inMain: stack.some((x) => x.name === "main") };
      s.frame = true;
      out.push(frame);
      continue;
    }
    if (CODE.has(name)) { s.code = true; code++; }
    if (name === "a" && a.href != null) cur().block.links.push(a.href);
    if (BLOCK.has(name)) {
      s.block = { tag: name, level: /^h[1-6]$/.test(name) ? Number(name[1]) : 0, text: "", code: "", links: [], inMain: name === "main" || stack.some((x) => x.name === "main"), start: t.index, end: src.length };
      out.push(s.block);
    }
  }
  return { blocks: [root, ...out], meta, attrs };
}

// ── sources ────────────────────────────────────────────────────────────────────────────────
/** The text a link into this repository points at (the heading's section, with a fragment), or null. */
export function repoSourceText(url, repoRoot) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const base = new URL(REPO_URL);
  if (u.origin !== base.origin || !(u.pathname === base.pathname || u.pathname.startsWith(`${base.pathname}/`))) return null;
  const m = /^\/(?:tree|blob)\/main(?:\/(.*))?$/.exec(u.pathname.slice(base.pathname.length).replace(/\/$/, ""));
  if (!m) return null;
  let file = path.join(repoRoot, ...decodeURIComponent(m[1] ?? "").split("/").filter(Boolean));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "README.md");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const frag = decodeURIComponent(u.hash.slice(1));
  if (!frag || !/\.md$/i.test(file)) return text;
  // The section under the heading the fragment names, down to the next heading of its level or above.
  const lines = text.split("\n");
  let fence = false, from = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    if (from >= 0 && h[1].length <= level) return lines.slice(from, i).join("\n");
    if (from < 0 && githubSlug(h[2]) === frag) { from = i; level = h[1].length; }
  }
  return from >= 0 ? lines.slice(from).join("\n") : null;
}

/**
 * Rule 2 on one page: every quantity in <main> is sourced (see the header). Returns findings;
 * `stats` counts the figures seen, and how the sourced ones in blocks were sourced.
 * @param {string} html
 * @param {{ from: string, repoRoot: string, stats?: { figures?: number, byRepository?: number, byCode?: number } }} opts
 */
export function figures(html, { from, repoRoot, stats = {} }) {
  const count = (k) => { stats[k] = (stats[k] ?? 0) + 1; };
  const { blocks: all, meta } = blocks(html);
  const findings = [];
  const flag = (why, where, q) => findings.push({ rule: "unsourced figure", what: `${from}: ${where}: ${show(q)} ${why}` });
  const sourceCache = new Map();
  const sourceQs = (url) => {
    if (!sourceCache.has(url)) { const t = repoSourceText(url, repoRoot); sourceCache.set(url, t == null ? null : quantities(t)); }
    return sourceCache.get(url);
  };
  const main = all.filter((b) => b.inMain);
  const codeAfter = (b) => {
    // The first thing after the block, if it is a code block with no prose in between.
    for (const x of main) {
      if (x.start < b.end) continue;
      if (x.tag === "codeblock") return x;
      if (x.text.trim()) return null;
    }
    return null;
  };
  const sourced = []; // { q, block } sourced in a prose block
  const headings = [];
  for (const b of main) {
    if (b.tag === "codeblock") continue;
    const qs = quantities(b.text);
    for (const _ of qs) count("figures");
    if (!qs.length) continue;
    if (b.level) { headings.push({ b, qs }); continue; }
    for (const q of qs) {
      const code = q.cls === "line" ? codeAfter(b) : null;
      if (code && code.lines === q.value) { sourced.push({ q, b }); count("byCode"); continue; }
      const links = b.links.map((h) => ({ h, qs: sourceQs(h) })).filter((l) => l.qs);
      if (links.some((l) => l.qs.some((s) => same(s, q)))) { sourced.push({ q, b }); count("byRepository"); continue; }
      const where = `<${b.tag}> "${b.text.replace(/\s+/g, " ").trim().slice(0, 80)}"`;
      if (code) flag(`counts lines, but the code block after it has ${code.lines}`, where, q);
      else if (links.length) flag(`is not stated by the repository document it links (${links.map((l) => l.h).join(", ")})`, where, q);
      else flag("has no source link in its block", where, q);
    }
  }
  const mainEnd = all.find((b) => b.tag === "main")?.end ?? html.length;
  for (const { b, qs } of headings) {
    // A heading's section: up to the next heading of its level or above.
    const next = main.find((x) => x.level && x.level <= b.level && x.start > b.start)?.start ?? mainEnd;
    for (const q of qs) {
      const ok = b.level === 1 ? sourced.some((s) => same(s.q, q)) : sourced.some((s) => same(s.q, q) && s.b.start > b.start && s.b.start < next);
      if (!ok) flag(b.level === 1 ? "is not sourced anywhere on the page" : "is not sourced in its section", `<h${b.level}> "${b.text.trim()}"`, q);
    }
  }
  for (const m of meta) for (const q of quantities(m.text)) {
    count("figures");
    if (!sourced.some((s) => same(s.q, q))) flag("is not sourced anywhere on the page", `${m.what} "${m.text.trim().slice(0, 80)}"`, q);
  }
  return findings;
}

/**
 * Rule 1 on one page: every block's prose and code, the title and descriptions, and the alt,
 * title, label and placeholder texts. `stats.runs` counts the runs of text read.
 */
export function legalLineOfPage(html, { from, stats = {} }) {
  const { blocks: all, meta, attrs } = blocks(html);
  const findings = [];
  const runs = [...all.flatMap((b) => [b.text, b.code]), ...meta.map((m) => m.text), ...attrs.map((a) => a.text)].filter((r) => r?.trim());
  stats.runs = (stats.runs ?? 0) + runs.length;
  for (const r of runs) for (const f of legalLine(r, stats)) findings.push({ ...f, what: `${from}: ${f.what}` });
  return findings;
}
