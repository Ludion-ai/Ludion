// WEB-3: every error a Gate can return has a help page at the exact URL the Gate links to, in
// English and in Japanese, saying what happened, why the site asks, how to fix it, and the
// three-minute path to VERIFIED. The list of codes is not typed in here: it is read from the Gate
// (decide() driven through every input shape, and every error literal in the adapters) and from
// spec §10.11. The site is built for real and served the way a static host serves it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, ERRORS, ERROR_HELP, CLASSES, denialHeaders } from "@ludion/gate-core";
import { buildSite } from "../build.mjs";
import { serve } from "../serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SECTIONS = {
  en: ["What happened", "Why this site asks", "How to fix it", "Get verified in 3 minutes"],
  ja: ["何が起きたか", "サイトがこれを求める理由", "直し方", "3分で検証済みになる"],
};
const MIN_SECTION_CHARS = { en: 120, ja: 60 };
const PATH_COMMANDS = ["npx ludion init", "npx ludion sign", "npx ludion doctor"];

/** Every (error → status) decide() returns, over every class and every route/credential shape. */
function decideErrors() {
  const seen = new Map();
  const opt = (xs) => [undefined, ...xs];
  for (const cls of CLASSES) for (const stapleError of opt(["staple_expired", "no_registry_keys"]))
    for (const depth of opt([0, 1, 2, 3, 4])) for (const ballast of opt([{ status: "active" }, { status: "none" }]))
      for (const mandate of opt([{ scope: ["read"] }, { scope: ["checkout"] }, {}]))
        for (const pressure of [0, 1, 2, 3]) for (const rd of opt([1, 3])) for (const rb of opt(["active"])) for (const rs of opt(["checkout"])) {
          const require = { ...(rd !== undefined ? { depth: rd } : {}), ...(rb ? { ballast: rb } : {}), ...(rs ? { scope: rs } : {}) };
          const d = decide({ class: cls, stapleError, depth, ballast, mandate }, { pressure, require });
          if (d.action !== "deny") continue;
          assert.ok(d.error, `a denial without an error code: ${JSON.stringify({ cls, pressure, require })}`);
          if (seen.has(d.error)) assert.equal(seen.get(d.error), d.status, `${d.error} with two statuses`);
          seen.set(d.error, d.status);
        }
  return seen;
}

/** Codes written as literals anywhere a Gate builds a response (adapters included). */
function literalErrors() {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "test", "bench"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?[jt]s$/.test(e.name)) for (const m of fs.readFileSync(p, "utf8").matchAll(/\berror:\s*"([a-z_]+)"|"Ludion-Error":\s*"([a-z_]+)"/g)) out.add(m[1] ?? m[2]);
    }
  };
  for (const d of fs.readdirSync(path.join(ROOT, "packages"))) if (d.startsWith("gate-")) walk(path.join(ROOT, "packages", d));
  return out;
}

/** The error table in spec §10.11: code → status. */
function specErrors() {
  const md = fs.readFileSync(path.join(ROOT, "docs/ludion-spec.md"), "utf8");
  const sec = md.slice(md.indexOf("### 10.11"), md.indexOf("### 10.12"));
  return new Map([...sec.matchAll(/^\|\s*(\d{3})\s*\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => [m[2], Number(m[1])]));
}

const text = (html) => html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const main = (html) => (/<main\b[^>]*>([\s\S]*)<\/main>/.exec(html) ?? [])[1] ?? "";

/** Split <main> into { heading text → section text } at every <h2>. */
function sections(html) {
  const parts = main(html).replace(/<a\b[^>]*class="sl-anchor-link"[\s\S]*?<\/a>/g, "").split(/<h2\b/).slice(1);
  return new Map(parts.map((p) => {
    const [, head, rest] = /^[^>]*>([\s\S]*?)<\/h2>([\s\S]*)$/.exec(p) ?? [, "", p];
    return [text(head), text(rest)];
  }));
}

let site, codes;
const gateErrors = decideErrors(), literals = literalErrors(), spec = specErrors();

before(async () => {
  codes = new Map([...Object.entries(ERRORS), ...spec]);
  site = await serve(buildSite());
});
after(async () => { await site?.close(); });

test("WEB-3: the Gate's error list is exactly what decide() returns, and every literal is on it", () => {
  assert.deepEqual([...gateErrors.keys()].sort(), Object.keys(ERRORS).sort(), "ERRORS drifted from decide()");
  for (const [code, status] of gateErrors) assert.equal(ERRORS[code], status, `${code}: status`);
  for (const code of literals) assert.ok(code in ERRORS, `a Gate package returns "${code}", which is not in ERRORS`);
  for (const [code, status] of spec) if (code in ERRORS) assert.equal(ERRORS[code], status, `${code}: spec §10.11 says ${status}`);
  assert.ok(spec.size >= Object.keys(ERRORS).length, "spec §10.11 table not found or shorter than the Gate's list");
});

async function page(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, html: r.status === 200 ? await r.text() : "" };
}

function checkPage(lang, code, status, url, html) {
  const where = `${lang} ${url}`;
  assert.match(html, new RegExp(`<html[^>]*\\blang="${lang}"`), `${where}: <html lang="${lang}">`);
  const h1 = text((/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html) ?? [])[1] ?? "");
  assert.ok(h1.includes(code), `${where}: the title names the code (got ${JSON.stringify(h1)})`);
  const body = text(main(html));
  assert.ok(body.includes(`Ludion-Error: ${code}`), `${where}: shows "Ludion-Error: ${code}"`);
  assert.ok(body.includes(`HTTP ${status}`), `${where}: shows "HTTP ${status}"`);
  const s = sections(html);
  for (const name of SECTIONS[lang]) {
    assert.ok(s.has(name), `${where}: section "${name}" (have: ${[...s.keys()].join(" / ")})`);
    assert.ok(s.get(name).length >= MIN_SECTION_CHARS[lang], `${where}: section "${name}" is too thin (${s.get(name).length} chars)`);
  }
  const path3 = s.get(SECTIONS[lang][3]);
  for (const c of PATH_COMMANDS) assert.ok(path3.includes(c), `${where}: the 3-minute path shows \`${c}\``);
  if (lang === "ja") {
    const jp = (body.match(/[぀-ヿ一-鿿]/g) ?? []).length;
    assert.ok(jp >= 300, `${where}: only ${jp} Japanese characters: a fallback or an untranslated page`);
  }
}

test("WEB-3: every code has /e/<code> in English and Japanese, at the URL the Gate links to", async () => {
  let n = 0;
  for (const [code, status] of codes) {
    // The exact help link a denial carries (Link header), and the one in the JSON body.
    const link = /^<([^>]+)>; rel="help"$/.exec(ERROR_HELP(code))?.[1];
    assert.ok(link, `${code}: ERROR_HELP shape`);
    if (code in ERRORS) assert.equal(denialHeaders({ action: "deny", error: code }).Link, ERROR_HELP(code));
    const u = new URL(link);
    assert.equal(u.origin, "https://ludion.ai");
    const en = await page(site.url + u.pathname);
    assert.equal(en.status, 200, `${code}: ${u.pathname} → ${en.status}`);
    checkPage("en", code, status, u.pathname, en.html);
    // The Japanese page: announced by the English one, and at /ja/e/<code>.
    const alt = /<link rel="alternate" hreflang="ja" href="([^"]+)"/.exec(en.html)?.[1];
    assert.equal(alt, `https://ludion.ai/ja/e/${code}`, `${code}: hreflang ja`);
    const ja = await page(`${site.url}/ja/e/${code}`);
    assert.equal(ja.status, 200, `${code}: /ja/e/${code} → ${ja.status}`);
    checkPage("ja", code, status, `/ja/e/${code}`, ja.html);
    n += 2;
  }
  console.log(`WEB-3: ${codes.size} codes × 2 languages = ${n} pages (Gate ${Object.keys(ERRORS).length}, spec §10.11 ${spec.size})`);
});

test("WEB-3: the error index lists every code, in both languages", async () => {
  for (const [lang, prefix] of [["en", ""], ["ja", "/ja"]]) {
    const r = await page(`${site.url}${prefix}/e`);
    assert.equal(r.status, 200, `${prefix}/e`);
    for (const code of codes.keys()) assert.ok(r.html.includes(`href="${prefix}/e/${code}"`), `${lang} index links ${prefix}/e/${code}`);
  }
});

test("WEB-3: an unknown code is a 404, so the checks above cannot pass on a catch-all page", async () => {
  for (const p of ["/e/not_a_ludion_error", "/ja/e/not_a_ludion_error"]) assert.equal((await page(site.url + p)).status, 404, p);
});
