// The link check for the site oracles (WEB-5). It reads markup, never a browser: a built page's
// files, or a live page's DOM as the browser serialised it, go through the same rules.
// - Every link and every load at the site's own origin (relative, or absolute at the site URL, as
//   canonical and hreflang are) resolves to a file the site ships, the way a static host serves it
//   (serve.mjs), and a fragment names an id in the page it lands on.
// - A load (script, stylesheet, image, font, icon, hint) comes from the site's own origin. The site
//   has no third party (NIGHT.md §2): the allowlist of other origins is empty.
// - A link into the repository on GitHub names a path that exists in this checkout, and a heading
//   in it when there is a fragment. Other links out are checked on the network (checkExternal).
import fs from "node:fs";
import path from "node:path";
import { resolveFile } from "../serve.mjs";

export const SITE_URL = process.env.LUDION_SITE_URL ?? "https://ludion.ai";
export const REPO_URL = "https://github.com/Ludion-ai/Ludion";

/** Every file under `root`, as "/"-separated relative paths. */
export function filesOf(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesOf(root, p, out); else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out.sort();
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const unescapeHtml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return NAMED[e.toLowerCase()] ?? m;
});

// A <link> with one of these rels makes the browser fetch its href; any other rel only names a URL.
const LOAD_RELS = /(^|\s)(stylesheet|icon|apple-touch-icon|mask-icon|manifest|preload|modulepreload|prefetch|prerender|preconnect|dns-prefetch)(\s|$)/i;
const LOAD_ATTRS = { script: ["src"], img: ["src", "srcset"], source: ["src", "srcset"], iframe: ["src"], video: ["src", "poster"],
  audio: ["src"], track: ["src"], embed: ["src"], object: ["data"], input: ["src"], image: ["href", "xlink:href"], use: ["href", "xlink:href"] };
const META_URLS = /^(og:url|og:image(:url|:secure_url)?|twitter:image)$/i;

/** url(...) and @import targets in a stylesheet. */
export function cssUrls(css) {
  const out = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const u = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (u) out.push(u);
  }
  return out;
}

/**
 * What a page refers to: `refs` are { kind: "link" | "load", what, url } (url as written), `ids`
 * are the fragment targets it offers. Script bodies are code, not markup; style bodies are CSS.
 */
export function extract(html) {
  const refs = [], ids = new Set();
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  const styles = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const markup = src.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1</script>").replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, "$1</style>");
  for (const css of styles) for (const url of cssUrls(css)) refs.push({ kind: "load", what: "<style> url()", url });
  let inLangSelect = false;
  for (const t of markup.matchAll(/<(\/?)([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const [, close, rawName, rawAttrs] = t;
    const name = rawName.toLowerCase();
    if (name === "starlight-lang-select") { inLangSelect = !close; continue; }
    if (close) continue;
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) attrs[a[1].toLowerCase()] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? "");
    if (attrs.id) ids.add(attrs.id);
    if (attrs.name && name === "a") ids.add(attrs.name);
    const push = (kind, what, url) => { if (url != null && url.trim() !== "") refs.push({ kind, what, url: url.trim() }); };
    if (attrs.style) for (const url of cssUrls(attrs.style)) push("load", `<${name} style> url()`, url);
    if ((name === "a" || name === "area") && "href" in attrs) push("link", `<${name} href>`, attrs.href);
    else if (name === "link" && "href" in attrs) push(LOAD_RELS.test(attrs.rel ?? "") ? "load" : "link", `<link rel="${attrs.rel ?? ""}">`, attrs.href);
    else if (name === "form" && "action" in attrs) push("link", "<form action>", attrs.action);
    else if (name === "meta" && META_URLS.test(attrs.property ?? attrs.name ?? "")) push("link", `<meta ${attrs.property ?? attrs.name}>`, attrs.content);
    else if (name === "option" && inLangSelect) push("link", "<option> (language)", attrs.value);
    for (const a of LOAD_ATTRS[name] ?? []) {
      if (!(a in attrs)) continue;
      if (a === "srcset") for (const c of attrs[a].split(",")) push("load", `<${name} srcset>`, c.trim().split(/\s+/)[0]);
      else push("load", `<${name} ${a}>`, attrs[a]);
    }
  }
  return { refs, ids };
}

/** URLs at the site's origin written into code or text (a script's strings, a copied report). */
export function siteUrlsIn(text, site = SITE_URL) {
  const esc = new URL(site).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not a longer host or another port: https://ludion.ai.example and https://ludion.ai:8443 are elsewhere.
  return [...new Set((text.match(new RegExp(`${esc}(?![\\w.:-])(?:/[^\\s"'\`<>)\\\\]*)?`, "g")) ?? []).map((u) => u.replace(/[.,;:]+$/, "")))];
}

/** The URL a built file answers at: e/x.html → /e/x, index.html → /, ja.html → /ja. */
export function publicPath(rel) {
  const p = `/${rel}`.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1");
  return p === "" ? "/" : p;
}

/** GitHub's anchor for a Markdown heading. */
export const githubSlug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/** Whether a link into this repository on GitHub lands on something: null if it does, else why not. */
export function repoLinkProblem(url, repoRoot) {
  const u = new URL(url);
  const base = new URL(REPO_URL);
  const rest = u.pathname.slice(base.pathname.length).replace(/\/$/, "");
  let rel = "";
  if (rest) {
    const m = /^\/(tree|blob)\/main(?:\/(.*))?$/.exec(rest);
    if (!m) return `not a path on main: ${rest}`;
    rel = decodeURIComponent(m[2] ?? "");
  }
  const abs = path.join(repoRoot, ...rel.split("/").filter(Boolean));
  if (!fs.existsSync(abs)) return `no ${rel} in the repository`;
  const frag = decodeURIComponent(u.hash.slice(1));
  if (!frag) return null;
  const isDir = fs.statSync(abs).isDirectory();
  const md = isDir ? path.join(abs, "README.md") : abs;
  if (!fs.existsSync(md) || !/\.md$/i.test(md)) return `#${frag}: no README.md to show`;
  if (isDir && frag === "readme") return null;
  const slugs = [...fs.readFileSync(md, "utf8").replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => githubSlug(m[1]));
  return slugs.includes(frag) ? null : `#${frag}: no such heading in ${path.relative(repoRoot, md).split(path.sep).join("/")}`;
}

const fragmentOf = (hash) => { try { return decodeURIComponent(hash.slice(1)); } catch { return hash.slice(1); } };
// A form or link that goes nowhere on purpose (Pagefind's search form has one): not a link.
const NO_OP = /^javascript:\s*(void\s*\(?\s*0\s*\)?\s*;?|;)?\s*$/i;

/**
 * Judge refs made from a page served at `from` (its public path). A link to a bare fragment is
 * judged against `selfIds`, the ids of the document it is in (a 404 page is served at any path).
 * Returns findings, and the links that leave the site and the repository (for checkExternal).
 * @param {{ kind: string, what: string, url: string }[]} refs
 * @param {{ root: string, from: string, selfIds: Set<string>, site?: string, repoRoot: string, idsOf: (file: string) => Set<string> }} opts
 */
export function checkRefs(refs, { root, from, selfIds, site = SITE_URL, repoRoot, idsOf }) {
  const findings = [], external = [];
  const siteOrigin = new URL(site).origin;
  const base = new URL(from, siteOrigin);
  const flag = (rule, r, why) => findings.push({ rule, what: `${from}: ${r.what} ${r.url}${why ? ` (${why})` : ""}` });
  for (const r of refs) {
    if (r.url.startsWith("#")) {
      const frag = fragmentOf(r.url);
      if (frag && frag !== "top" && !selfIds.has(frag)) flag("broken fragment", r, `no id "${frag}" in this page`);
      continue;
    }
    if (NO_OP.test(r.url)) continue;
    let u;
    try { u = new URL(r.url, base); } catch { flag("broken link", r, "not a URL"); continue; }
    if (["data:", "blob:", "about:"].includes(u.protocol) && r.kind === "load") continue;
    if (["mailto:", "tel:"].includes(u.protocol) && r.kind === "link") continue;
    if (u.protocol === "javascript:") { flag("broken link", r, "runs code, links nowhere"); continue; }
    if (u.origin !== siteOrigin) {
      if (r.kind === "load") { flag("loads from another origin", r); continue; }
      if (!["http:", "https:"].includes(u.protocol)) { flag("broken link", r, `scheme ${u.protocol}`); continue; }
      const repo = new URL(REPO_URL);
      if (u.origin === repo.origin && (u.pathname === repo.pathname || u.pathname.startsWith(`${repo.pathname}/`))) {
        const why = repoLinkProblem(u.href, repoRoot);
        if (why) flag("broken link", r, why);
      } else external.push({ url: u.href, from, what: r.what });
      continue;
    }
    const file = resolveFile(root, u.pathname);
    if (!file) { flag(r.kind === "load" ? "broken load" : "broken link", r); continue; }
    const frag = fragmentOf(u.hash);
    if (frag && frag !== "top" && file.endsWith(".html") && !idsOf(file).has(frag)) flag("broken fragment", r, `no id "${frag}"`);
  }
  return { findings, external };
}

/**
 * Check a whole built site: every page's markup, every stylesheet's url()s, every URL at the site's
 * origin in a script, every sitemap entry.
 * @returns {{ findings: {rule: string, what: string}[], external: {url: string, from: string, what: string}[], pages: string[], counts: object }}
 */
export function checkSite(root, { site = SITE_URL, repoRoot }) {
  root = path.resolve(root);
  const files = filesOf(root);
  const pages = files.filter((f) => f.endsWith(".html"));
  const idCache = new Map();
  const idsOf = (file) => {
    if (!idCache.has(file)) idCache.set(file, extract(fs.readFileSync(file, "utf8")).ids);
    return idCache.get(file);
  };
  const findings = [], external = [];
  const counts = { pages: pages.length, links: 0, loads: 0, scripts: 0, stylesheets: 0, sitemap: 0 };
  const run = (refs, from, selfIds = new Set()) => {
    const r = checkRefs(refs, { root, from, selfIds, site, repoRoot, idsOf });
    findings.push(...r.findings);
    external.push(...r.external);
  };
  for (const f of pages) {
    const { refs } = extract(fs.readFileSync(path.join(root, f), "utf8"));
    for (const r of refs) counts[r.kind === "load" ? "loads" : "links"]++;
    run(refs, publicPath(f), idsOf(path.join(root, f)));
  }
  for (const f of files.filter((x) => x.endsWith(".css"))) {
    const refs = cssUrls(fs.readFileSync(path.join(root, f), "utf8")).map((url) => ({ kind: "load", what: "url()", url }));
    counts.stylesheets++;
    counts.loads += refs.length;
    run(refs, `/${f}`);
  }
  for (const f of files.filter((x) => /\.m?js$/.test(x))) {
    const refs = siteUrlsIn(fs.readFileSync(path.join(root, f), "utf8"), site).map((url) => ({ kind: "link", what: "URL in script", url }));
    counts.scripts++;
    counts.links += refs.length;
    run(refs, `/${f}`);
  }
  for (const f of files.filter((x) => x.endsWith(".xml"))) {
    const refs = [...fs.readFileSync(path.join(root, f), "utf8").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => ({ kind: "link", what: "<loc>", url: unescapeHtml(m[1]) }));
    counts.sitemap += refs.length;
    run(refs, `/${f}`);
  }
  return { findings, external, pages, counts, idsOf };
}

/**
 * Links out, checked on the network. A 404 or 410 is a broken link; anything else that is not an
 * answer (no network, a timeout, a 5xx, a 429) leaves the link unchecked, and says so.
 * @returns {Promise<{ url: string, status: number|null, error: string|null, broken: boolean }[]>}
 */
export async function checkExternal(urls, { timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  const out = [];
  for (const url of [...new Set(urls)]) {
    let status = null, error = null;
    try {
      let r = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if ([403, 405, 501].includes(r.status)) {
        r = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        await r.body?.cancel();
      }
      status = r.status;
    } catch (e) { error = e?.cause?.code ?? e?.name ?? String(e); }
    out.push({ url, status, error, broken: status === 404 || status === 410 });
  }
  return out;
}
