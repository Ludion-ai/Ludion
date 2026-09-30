// The built site's pages, as URLs, and the English/Japanese pairing (WEB-1, WEB-9).
// English lives at the root, Japanese under /ja/ (index.html ↔ ja.html, X.html ↔ ja/X.html).
// html_handling is "drop-trailing-slash": index.html is "/", scan.html is "/scan", ja.html is "/ja".
import fs from "node:fs";
import path from "node:path";

export function htmlFiles(dist) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "_astro" && e.name !== "pagefind") walk(p); }
      else if (e.name.endsWith(".html")) out.push(path.relative(dist, p).split(path.sep).join("/"));
    }
  })(dist);
  return out.sort();
}

export const urlOf = (file) => (file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`);
const isJa = (f) => f === "ja.html" || f.startsWith("ja/");
const enOf = (ja) => (ja === "ja.html" ? "index.html" : ja.slice(3));
const jaOf = (en) => (en === "index.html" ? "ja.html" : `ja/${en}`);

/** Problems with the English/Japanese pairing and the lang attributes. */
export function pairing(dist) {
  const files = htmlFiles(dist), set = new Set(files), problems = [];
  for (const f of files) {
    if (isJa(f) ? !set.has(enOf(f)) : !set.has(jaOf(f))) problems.push(`${f} has no ${isJa(f) ? "English" : "Japanese"} counterpart`);
    const lang = /<html[^>]*\blang="([^"]+)"/i.exec(fs.readFileSync(path.join(dist, f), "utf8"))?.[1];
    if (lang !== (isJa(f) ? "ja" : "en")) problems.push(`${f} has lang="${lang}"`);
  }
  return { files, problems, en: files.filter((f) => !isJa(f)).length, ja: files.filter(isJa).length };
}

/** One page per template, in both languages (WEB-9's Lighthouse set). The nine /e/<code> pages share one template. */
export const TEMPLATES = ["index.html", "scan.html", "gate.html", "e.html", "e/signature_required.html", "404.html"];
export const templatePages = () => TEMPLATES.flatMap((f) => [f, jaOf(f)]);
