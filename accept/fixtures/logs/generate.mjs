#!/usr/bin/env node
// accept/fixtures/logs/generate.mjs — the scan corpus (SCAN-1/2/3) and its ground truth.
//
//   node accept/fixtures/logs/generate.mjs              rewrite corpus/ and truth/ here
//   node accept/fixtures/logs/generate.mjs --out DIR    write them under DIR instead (SCAN-1
//                                                       checks the committed corpus is reproducible)
//
// Deterministic (seeded). Ground truth comes from the hand-written tables below (each
// User-Agent and each route carries its label), never from the scan itself. Every vendor file
// also carries that vendor's documented example lines verbatim, labelled by hand. Addresses are
// from documentation/benchmark ranges (RFC 5737, RFC 2544, RFC 3849) plus the private
// addresses that appear in the vendors' own examples.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = process.argv.indexOf("--out");
const DIR = OUT >= 0 ? path.resolve(process.argv[OUT + 1]) : path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 8, 29, 0, 0, 0);

// Independent copies of the definitions in docs/MISSION.md SCAN-2 / README.md (not imported).
const CLASSES = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED", "UNKNOWN"];
const KINDS = ["checkout", "login", "signup", "account", "form", "search", "api", "asset", "browse", "malformed"];
const CRITICAL_KINDS = new Set(["checkout", "login", "signup", "account"]);
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTOMATION = new Set(["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED"]);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
function weighted(r, xs) {
  const total = xs.reduce((n, x) => n + x.w, 0);
  let t = r() * total;
  for (const x of xs) if ((t -= x.w) < 0) return x;
  return xs[xs.length - 1];
}
const chars = (r, n, alphabet) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
const LOWER = "abcdefghijklmnopqrstuvwxyz", ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", HEX = "0123456789abcdef";

// ── User-Agents, labelled by hand ──────────────────────────────────────────────────────────
const BROWSERS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  'Mozilla/5.0 (X11; Linux x86_64) "Quoted" Browser/1.0',            // quotes inside the UA
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ｆｕｌｌｗｉｄｔｈ/1.0 ブラウザ", // non-ASCII
].map((ua) => ({ ua, class: "UNKNOWN", w: 7 }));

const DECLARED = [
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", "OpenAI", 5],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "OpenAI", 3],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OpenAI", 2],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "Anthropic", 4],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "Anthropic", 2],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "Perplexity", 2],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "Perplexity", 1],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Google", 4],
  ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.137 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Google", 2],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Microsoft", 2],
  ["Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", "Amazon", 1],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "Apple", 1],
  ["Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", "ByteDance", 1],
  ["CCBot/2.0 (https://commoncrawl.org/faq/)", "Common Crawl", 1],
  ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta", 1],
  ["DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)", "DuckDuckGo", 1],
  // A known token wins over an automation signal in the same string (spec §11.5 order).
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) python-requests/2.31.0", "Google", 1],
].map(([ua, operator, w]) => ({ ua, class: "DECLARED", operator, w }));

const SUSPECTED = [
  ["curl/8.7.1", "curl/", 4],
  ["python-requests/2.32.3", "python-requests", 4],
  ["Python-urllib/3.12", "python-urllib", 1],
  ["Python/3.12 aiohttp/3.9.5", "aiohttp", 1],
  ["python-httpx/0.27.0", "httpx", 1],
  ["Go-http-client/2.0", "go-http-client", 2],
  ["okhttp/4.12.0", "okhttp", 1],
  ["Java/17.0.2", "java/", 1],
  ["axios/1.7.2", "axios/", 1],
  ["node-fetch/1.0 (+https://github.com/bitinn/node-fetch)", "node-fetch", 1],
  ["Scrapy/2.11.2 (+https://scrapy.org)", "scrapy", 2],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36", "headlesschrome", 3],
  ["Wget/1.21.4", "wget/", 1],
  ["libwww-perl/6.72", "libwww-perl", 1],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.39.95 Chrome/126.0.6478.127 Electron/31.2.1 Safari/537.36", "electron", 1],
  ["", "missing-user-agent", 3],
].map(([ua, signal, w]) => ({ ua, class: "SUSPECTED", signal, w }));

const UAS = [...BROWSERS, ...DECLARED, ...SUSPECTED];
const CRAWLERS = DECLARED.filter((d) => /bot|spider|crawl|agent/i.test(d.ua));
const SIGNERS = [DECLARED[1], DECLARED[4], DECLARED[6]]; // ChatGPT-User, Claude-User, Perplexity-User

// ── routes, labelled by hand (kind per the rule in README.md) ─────────────────────────────
const ROUTES = [
  ["/", "browse", 10], ["/about", "browse", 3], ["/pricing", "browse", 3], ["/blog/{slug}", "browse", 6],
  ["/blog/checkout-tips", "browse", 1], ["/products/{id}", "browse", 8], ["/products/{id}/reviews", "form", 2],
  ["/users/{user}", "browse", 6, { crawl: true }], ["/u/{rare}", "browse", 1], ["/{handle}", "browse", 1],
  ["/files/{uuid}", "browse", 1], ["/share/{jwt}", "browse", 1], ["/people/{enc}", "browse", 1],
  ["/unsubscribe/{email}", "browse", 1], ["/newsletter/confirm/{token}", "form", 1],
  ["/robots.txt", "browse", 2], ["/sitemap.xml", "browse", 1],
  ["/search?q={qv}", "search", 4], ["/products?q={qv}&page={n}", "search", 2],
  ["/login", "login", 4], ["/login", "login", 3, { m: "POST" }], ["/wp-login.php", "login", 2, { m: "POST" }],
  ["/account/login", "login", 1], ["/oauth/authorize?client_id={qv}&state={qv}", "login", 1],
  ["/xmlrpc.php", "login", 1, { m: "POST" }], ["/password/reset/{token}", "login", 1],
  ["/signup", "signup", 2], ["/register", "signup", 1, { m: "POST" }],
  ["/cart", "checkout", 3], ["/cart/add?sku={qv}", "checkout", 2, { m: "POST" }], ["/checkout/{uuid}/payment", "checkout", 1],
  ["/checkout", "checkout", 1, { m: "POST" }], ["/orders/{id}", "checkout", 1], ["/my-account/orders", "checkout", 1],
  ["/api/cart/items", "checkout", 1, { m: "POST" }],
  ["/account", "account", 2], ["/users/{user}/settings", "account", 1], ["/wp-admin/", "account", 1],
  ["/contact", "form", 2], ["/contact", "form", 1, { m: "POST" }], ["/wp-comments-post.php", "form", 1, { m: "POST" }],
  ["/api/v1/products?page={n}", "api", 3], ["/graphql", "api", 2, { m: "POST" }], ["/wp-json/wp/v2/posts", "api", 1],
  ["/v2/items/{id}", "api", 1, { m: "PUT" }], ["/api/v1/items/{id}", "api", 1, { m: "DELETE" }],
  ["/static/app.{hex}.js", "asset", 4], ["/favicon.ico", "asset", 3], ["/assets/logo.png", "asset", 2],
  ["/images/login.png", "asset", 1], ["/_next/static/chunks/{hex}.js", "asset", 2], ["/static/cart.js", "asset", 1],
  ["/", "browse", 1, { m: "HEAD" }],
].map(([t, kind, w, o = {}]) => ({ t, kind, w, m: o.m ?? "GET", crawl: !!o.crawl }));

const SLUGS = Array.from({ length: 40 }, (_, i) => ["how-to", "why", "guide-to", "notes-on", "the-case-for"][i % 5] + "-" + ["running", "cooking", "sleeping", "saving", "hiring", "shipping", "writing", "learning"][i % 8] + (i >= 20 ? "-again" : ""));
const NAMES_JA = ["山田太郎", "佐藤花子", "鈴木一郎", "高橋美咲"];

/** Expand a route template. Returns the target and the identifier values it contains. */
function expand(t, r, users) {
  const seg = [], qv = [];
  const target = t.replace(/\{(\w+)\}/g, (_, k) => {
    let v;
    switch (k) {
      case "id": v = String(int(r, 100000, 999999999)); seg.push(v); break;
      case "uuid": v = `${chars(r, 8, HEX)}-${chars(r, 4, HEX)}-4${chars(r, 3, HEX)}-a${chars(r, 3, HEX)}-${chars(r, 12, HEX)}`; seg.push(v); break;
      case "user": v = pick(r, users); seg.push(v); break;
      case "rare": v = chars(r, 9, LOWER); seg.push(v); break;
      case "handle": v = `@${chars(r, 7, LOWER)}`; seg.push(v, v.slice(1)); break;
      case "jwt": v = `eyJhbGciOiJIUzI1NiJ9.${chars(r, 24, ALNUM)}.${chars(r, 22, ALNUM)}`; seg.push(v); break;
      case "enc": { const n = pick(r, NAMES_JA); v = encodeURIComponent(n); seg.push(v, n); break; }
      case "email": v = `${chars(r, 6, LOWER)}.${chars(r, 4, LOWER)}+${int(r, 10, 99)}@example.com`; seg.push(v, encodeURIComponent(v)); break;
      case "token": v = chars(r, 21, ALNUM) + int(r, 100, 999); seg.push(v); break;
      case "hex": v = chars(r, 10, HEX) + int(r, 10, 99); seg.push(v); break;
      case "slug": v = pick(r, SLUGS); break;
      case "qv": v = `qv${chars(r, 10, "abcdefghjkmnpqrstuvwxyz23456789")}`; qv.push(v); break;
      case "n": v = String(int(r, 2, 20)); break;
      default: throw new Error(k);
    }
    return v;
  });
  return { target, seg, qv };
}

function ip(r) {
  const x = r();
  if (x < 0.2) return `2001:db8:${int(r, 1, 0xfffe).toString(16)}::${int(r, 1, 0xffff).toString(16)}`;
  if (x < 0.3) return `${pick(r, ["192.0.2", "198.51.100", "203.0.113"])}.${int(r, 1, 254)}`;
  return `198.${int(r, 18, 19)}.${int(r, 0, 255)}.${int(r, 1, 254)}`;
}

function statusFor(r, kind, method) {
  const x = r();
  if (kind === "login" && method === "POST") return x < 0.6 ? 302 : 401;
  if (WRITES.has(method)) return x < 0.7 ? 200 : x < 0.85 ? 403 : 422;
  return x < 0.82 ? 200 : x < 0.88 ? 301 : x < 0.95 ? 404 : x < 0.98 ? 403 : 500;
}

/**
 * Abstract requests for one fixture.
 * @param {{ seed: number, n: number, signed?: boolean }} o
 */
function traffic(o) {
  const r = rng(o.seed);
  const users = Array.from({ length: 40 }, () => chars(r, 8, LOWER));
  const out = [];
  let t = T0;
  for (let i = 0; i < o.n; i++) {
    t += int(r, 1, 280) * 1000 + int(r, 0, 999);
    const route = weighted(r, ROUTES);
    const { target, seg, qv } = expand(route.t, r, users);
    let u = route.crawl && r() < 0.85 ? weighted(r, CRAWLERS) : weighted(r, UAS);
    const signed = !!o.signed && r() < 0.07;
    if (signed) u = pick(r, SIGNERS);
    const cls = signed ? "UNVERIFIED" : u.class;
    out.push({
      ts: t, ip: ip(r), method: route.m, target, kind: route.kind, ua: u.ua, class: cls,
      operator: signed ? undefined : u.operator, signal: signed ? undefined : u.signal, signed,
      status: statusFor(r, route.kind, route.m), bytes: int(r, 0, 90000),
      referer: r() < 0.3 ? `https://www.google.com/search?q=rf${chars(r, 8, LOWER)}` : "",
      cookie: r() < 0.25 ? `session=ck${chars(r, 16, ALNUM)}; theme=dark` : "",
      canaries: { seg, qv },
    });
  }
  return { r, reqs: out };
}

// ── escaping as each server does it ───────────────────────────────────────────────────────
function escBytes(s, quoteStyle) {
  let o = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') o += quoteStyle === "nginx" ? "\\x22" : '\\"';
    else if (ch === "\\") o += quoteStyle === "nginx" ? "\\x5C" : "\\\\";
    else if (c < 0x20 || c >= 0x7f) o += [...Buffer.from(ch, "utf8")].map((b) => `\\x${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    else o += ch;
  }
  return o;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function clfTime(ms, offMin) {
  const d = new Date(ms + offMin * 60_000), p = (x) => String(x).padStart(2, "0");
  const sign = offMin >= 0 ? "+" : "-", a = Math.abs(offMin);
  return `${p(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${sign}${p(Math.floor(a / 60))}${p(a % 60)}`;
}
const iso = (ms) => new Date(ms).toISOString();
const isoSec = (ms) => iso(ms).replace(/\.\d{3}Z$/, "Z");
const cfEncode = (s) => s.replace(/[%"\t ]|[^\x20-\x7e]/gu, (ch) => [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));

// ── truth ─────────────────────────────────────────────────────────────────────────────────
/** A good record: fields the parser must extract + labels the counts must match. */
const good = (q, overrides = {}) => ({ ok: true, method: q.method, target: q.target, status: q.status, ua: q.ua,
  class: q.class, kind: q.kind, operator: q.operator, signal: q.signal, ...overrides });

function expectFrom(lines) {
  const classes = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { ...Object.fromEntries(CLASSES.map((c) => [c, 0])), writes: 0 }]));
  const operators = {}, signals = {}, byKind = {};
  let critical = 0, served = 0, noUa = 0, records = 0, parsed = 0, nonRequests = 0;
  for (const entries of lines) {
    if (!entries.length) nonRequests++;
    for (const e of entries) {
      records++;
      if (!e.ok) continue;
      parsed++;
      classes[e.class]++;
      if (e.noUaField) noUa++;
      if (e.class === "DECLARED") operators[e.operator] = (operators[e.operator] ?? 0) + 1;
      if (e.class === "SUSPECTED") signals[e.signal] = (signals[e.signal] ?? 0) + 1;
      kinds[e.kind][e.class]++;
      if (WRITES.has(e.method ?? "")) kinds[e.kind].writes++;
      const crit = e.kind !== "malformed" && (CRITICAL_KINDS.has(e.kind) || WRITES.has(e.method ?? ""));
      if (AUTOMATION.has(e.class) && e.class !== "VERIFIED" && crit) {
        critical++; byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        if (e.status != null && e.status > 0 && e.status < 400) served++;
      }
    }
  }
  return { records, parsed, non_requests: nonRequests,
    expect: { classes, operators, signals, kinds, critical: { unverified_automation: critical, served, by_kind: byKind }, no_user_agent_field: noUa } };
}

function canariesOf(reqs, extra = {}) {
  const c = { ips: new Set(extra.ips ?? []), query_values: new Set(), path_segments: new Set(), other: new Set(extra.other ?? []) };
  for (const q of reqs) {
    if (q.ip) c.ips.add(q.ip);
    for (const v of q.canaries?.qv ?? []) c.query_values.add(v);
    for (const v of q.canaries?.seg ?? []) c.path_segments.add(v);
    if (q.cookie) c.other.add(q.cookie.split(";")[0].split("=")[1]);
    if (q.referer) c.other.add(q.referer.split("q=")[1]);
    if (q.xff) c.ips.add(q.xff);
  }
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [...v].sort()]));
}

/** Cut a line inside its first quoted field: the last line of a log still being written. */
function truncate(line) {
  return line.slice(0, line.indexOf('"') + 6);
}
/** ALB: quotes and backslashes escaped, UTF-8 left as is (our assumption; AWS does not say). */
const escAlb = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function write(name, meta, lines, truthLines, reqs, extra) {
  const eol = meta.crlf ? "\r\n" : "\n";
  let text = lines.join(eol);
  if (!meta.truncatedLast) text += eol; // a truncated last line has no newline
  let buf = Buffer.from((meta.bom ? "﻿" : "") + text, "utf8");
  if (meta.gzip) buf = zlib.gzipSync(buf, { level: 9, mtime: 0 });
  fs.writeFileSync(path.join(DIR, "corpus", name), buf);
  const t = expectFrom(truthLines);
  const truth = { file: name, vendor: meta.vendor, format: meta.format, gzip: !!meta.gzip, crlf: !!meta.crlf, bom: !!meta.bom,
    records: t.records, parsed: t.parsed, non_requests: t.non_requests, expect: t.expect,
    canaries: canariesOf(reqs, extra), lines: truthLines };
  const { lines: tl, ...head } = truth;
  const json = JSON.stringify(head, null, 1).replace(/\n}$/, `,\n "lines": [\n${tl.map((l) => JSON.stringify(l)).join(",\n")}\n ]\n}`);
  fs.writeFileSync(path.join(DIR, "truth", `${name.replace(/\.gz$/, "")}.truth.json`), json + "\n");
  return truth;
}

const clean = (u) => u; // UA as logged and recovered unchanged
const fields = (q, uaOut) => ({ ...q, ua: uaOut });

// ── nginx (stock nginx.conf `main`: combined + "$http_x_forwarded_for") ──────────────────────
function nginx() {
  const { r, reqs } = traffic({ seed: 101, n: 320 });
  const lines = [], truth = [];
  for (const q of reqs) {
    q.xff = r() < 0.2 ? ip(r) : "";
    lines.push(`${q.ip} - - [${clfTime(q.ts, 540)}] "${escBytes(`${q.method} ${q.target} HTTP/1.1`, "nginx")}" ${q.status} ${q.bytes} "${escBytes(q.referer || "-", "nginx")}" "${escBytes(q.ua || "-", "nginx")}" "${q.xff || "-"}"`);
    truth.push([good(q)]);
  }
  // Awkward real-world lines.
  const odd = [
    { line: `198.18.7.7 - - [29/Sep/2026:10:00:00 +0900] "\\x16\\x03\\x01\\x00\\xCA\\x01\\x00\\x00\\xC6\\x03\\x03" 400 157 "-" "-" "-"`, e: { ok: true, method: null, target: null, status: 400, ua: "", class: "SUSPECTED", signal: "missing-user-agent", kind: "malformed" } },
    { line: `198.18.7.8 - - [29/Sep/2026:10:00:01 +0900] "" 400 0 "-" "-" "-"`, e: { ok: true, method: null, target: null, status: 400, ua: "", class: "SUSPECTED", signal: "missing-user-agent", kind: "malformed" } },
    { line: `2001:db8:77::1 - - [29/Sep/2026:10:00:02 +0900] "GET /login HTTP/2.0" 499 0 "-" "curl/8.7.1" "-"`, e: { ok: true, method: "GET", target: "/login", status: 499, ua: "curl/8.7.1", class: "SUSPECTED", signal: "curl/", kind: "login" } },
    { line: `198.18.7.9 - alice [29/Sep/2026:10:00:03 +0900] "GET /account HTTP/1.1" 200 812 "-" "Mozilla/5.0 (compatible; \\x22Quoted\\x22Bot/1.0)" "-"`, e: { ok: true, method: "GET", target: "/account", status: 200, ua: 'Mozilla/5.0 (compatible; "Quoted"Bot/1.0)', class: "UNKNOWN", kind: "account" } },
    { line: `198.18.7.10 - - [29/Sep/2026:10:00:04 +0900] "GET http://www.example.com/checkout HTTP/1.1" 200 12 "-" "python-requests/2.32.3" "-"`, e: { ok: true, method: "GET", target: "http://www.example.com/checkout", status: 200, ua: "python-requests/2.32.3", class: "SUSPECTED", signal: "python-requests", kind: "checkout" } },
  ];
  lines.splice(40, 0, ...odd.map((o) => o.line));
  truth.splice(40, 0, ...odd.map((o) => [o.e]));
  const cut = reqs[reqs.length - 1];
  void cut;
  lines[lines.length - 1] = truncate(lines[lines.length - 1]);
  truth[truth.length - 1] = [{ ok: false }];
  return write("nginx-access.log", { vendor: "nginx", format: "combined", truncatedLast: true }, lines, truth, reqs, { ips: ["198.18.7.7", "198.18.7.8", "2001:db8:77::1", "198.18.7.9", "198.18.7.10"], other: ["alice"] });
}

// ── Apache combined (CRLF, `\"` escaping, hostname lookups, %u) ────────────────────────────
function apacheCombined() {
  const { r, reqs } = traffic({ seed: 202, n: 300 });
  const lines = [], truth = [];
  // httpd docs example, verbatim.
  lines.push(`127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)"`);
  truth.push([{ ok: true, method: "GET", target: "/apache_pb.gif", status: 200, ua: "Mozilla/4.08 [en] (Win98; I ;Nav)", class: "UNKNOWN", kind: "asset" }]);
  for (const q of reqs) {
    const host = r() < 0.1 ? `crawl-${q.ip.replace(/[.:]/g, "-")}.example.net` : q.ip;
    if (host !== q.ip) q.xff = host;
    lines.push(`${host} - - [${clfTime(q.ts, -420)}] "${escBytes(`${q.method} ${q.target} HTTP/1.1`, "apache")}" ${q.status} ${q.bytes || "-"} "${escBytes(q.referer || "-", "apache")}" "${escBytes(q.ua || "-", "apache")}"`);
    truth.push([good(q)]);
  }
  lines.push(`198.51.100.20 - - [29/Sep/2026:05:00:00 -0700] "POST /wp-login.php HTTP/1.1" 200 3984 "-" "Mozilla/5.0 (Windows NT 6.1; \\"compatible\\") \\\\Brute\\\\"`);
  truth.push([{ ok: true, method: "POST", target: "/wp-login.php", status: 200, ua: 'Mozilla/5.0 (Windows NT 6.1; "compatible") \\Brute\\', class: "UNKNOWN", kind: "login" }]);
  lines.push(`this is not a log line at all`);
  truth.push([{ ok: false }]);
  const last = reqs[reqs.length - 1];
  lines.push(truncate(`198.51.100.21 - - [29/Sep/2026:05:00:01 -0700] "GET /cart HTTP/1.1" 200 51 "-" "${last.ua || "curl/8.7.1"}"`));
  truth.push([{ ok: false }]);
  return write("apache-combined.log", { vendor: "apache", format: "combined", crlf: true, truncatedLast: true }, lines, truth, reqs, { ips: ["127.0.0.1", "198.51.100.20", "198.51.100.21"], other: ["frank"] });
}

// ── Apache common (no User-Agent field at all) ────────────────────────────────────────────
function apacheCommon() {
  const { reqs } = traffic({ seed: 303, n: 260 });
  const lines = [], truth = [];
  lines.push(`127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326`);
  truth.push([{ ok: true, method: "GET", target: "/apache_pb.gif", status: 200, ua: undefined, class: "UNKNOWN", kind: "asset", noUaField: true }]);
  for (const q of reqs) {
    lines.push(`${q.ip} - - [${clfTime(q.ts, 0)}] "${escBytes(`${q.method} ${q.target} HTTP/1.1`, "apache")}" ${q.status} ${q.bytes || "-"}`);
    truth.push([good(q, { ua: undefined, class: "UNKNOWN", operator: undefined, signal: undefined, noUaField: true })]);
  }
  return write("apache-common.log", { vendor: "apache", format: "common" }, lines, truth, reqs, { ips: ["127.0.0.1"], other: ["frank"] });
}

// ── Caddy (structured JSON; all request headers, so signatures are visible) ───────────────
function caddy() {
  const { r, reqs } = traffic({ seed: 404, n: 300, signed: true });
  const lines = [], truth = [];
  lines.push(JSON.stringify({ level: "info", ts: 1759104000.1, logger: "tls.obtain", msg: "certificate obtained successfully", identifier: "www.example.com" }));
  truth.push([]);
  lines.push(JSON.stringify({ level: "info", ts: 1759104000.2, msg: "serving initial configuration" }));
  truth.push([]);
  // docs example (one line; the docs' trailing comma removed so it is JSON)
  lines.push(`{"level":"info","ts":1646861401.5241024,"logger":"http.log.access","msg":"handled request","request":{"remote_ip":"127.0.0.1","remote_port":"41342","client_ip":"127.0.0.1","proto":"HTTP/2.0","method":"GET","host":"localhost","uri":"/","headers":{"User-Agent":["curl/7.82.0"],"Accept":["*/*"],"Accept-Encoding":["gzip, deflate, br"]},"tls":{"resumed":false,"version":772,"cipher_suite":4865,"proto":"h2","server_name":"example.com"}},"bytes_read":0,"user_id":"","duration":0.000929675,"size":10900,"status":200,"resp_headers":{"Server":["Caddy"],"Content-Encoding":["gzip"],"Content-Type":["text/html; charset=utf-8"],"Vary":["Accept-Encoding"]}}`);
  truth.push([{ ok: true, method: "GET", target: "/", status: 200, ua: "curl/7.82.0", class: "SUSPECTED", signal: "curl/", kind: "browse" }]);
  for (const q of reqs) {
    const headers = { Accept: ["*/*"] };
    if (q.ua) headers["User-Agent"] = [q.ua];
    if (q.cookie) headers.Cookie = [q.cookie];
    if (q.signed) {
      headers["Signature-Agent"] = ['"https://chatgpt.com"'];
      headers["Signature-Input"] = [`sig1=("@authority" "signature-agent";key="sig1");created=${Math.floor(q.ts / 1000)};expires=${Math.floor(q.ts / 1000) + 60};keyid="${chars(r, 43, ALNUM)}";tag="web-bot-auth"`];
      headers.Signature = [`sig1=:${chars(r, 86, ALNUM)}==:`];
    }
    const [host] = ["www.example.com"];
    lines.push(JSON.stringify({ level: "info", ts: q.ts / 1000, logger: "http.log.access.log0", msg: "handled request",
      request: { remote_ip: q.ip, remote_port: String(int(r, 1024, 65535)), client_ip: q.ip, proto: "HTTP/2.0", method: q.method, host, uri: q.target, headers },
      bytes_read: 0, user_id: "", duration: r() / 10, size: q.bytes, status: q.status, resp_headers: { Server: ["Caddy"] } }));
    truth.push([good(q, { ua: q.ua })]);
  }
  const last = lines.pop(); truth.pop();
  lines.push(last.slice(0, Math.floor(last.length * 0.7)));
  truth.push([{ ok: false }]);
  return write("caddy-access.log", { vendor: "caddy", format: "caddy", truncatedLast: true }, lines, truth, reqs, { ips: ["127.0.0.1"] });
}

// ── Cloudflare Logpush, http_requests dataset (NDJSON, gzip, unixnano) ───────────────────
function cloudflare() {
  const { r, reqs } = traffic({ seed: 505, n: 320, signed: true });
  const lines = [], truth = [];
  for (const q of reqs) {
    const rh = {};
    if (q.signed) { rh["signature-agent"] = '"https://claude.ai"'; rh["signature-input"] = `sig1=("@authority" "signature-agent");created=${Math.floor(q.ts / 1000)};tag="web-bot-auth"`; }
    const o = { ClientIP: q.ip, ClientRequestHost: "www.example.com", ClientRequestMethod: q.method, ClientRequestURI: q.target,
      ClientRequestUserAgent: q.ua, ClientRequestReferer: q.referer, ClientRequestProtocol: "HTTP/2", ClientCountry: pick(r, ["jp", "us", "de", "sg"]),
      EdgeResponseStatus: q.status, OriginResponseStatus: q.status, RayID: chars(r, 16, HEX), BotScore: int(r, 1, 99),
      RequestHeaders: rh, SecurityAction: q.status === 403 ? "block" : "" };
    let line = JSON.stringify(o);
    const ns = `${q.ts}000000`;
    line = line.replace(/^\{/, `{"EdgeStartTimestamp":${ns},"EdgeEndTimestamp":${ns},`);
    lines.push(line);
    truth.push([good(q)]);
  }
  // A job configured with timestamp_format=rfc3339 writes strings.
  lines.splice(100, 0, JSON.stringify({ EdgeStartTimestamp: "2026-09-29T08:00:00Z", ClientIP: "2001:db8:cf::1", ClientRequestHost: "www.example.com", ClientRequestMethod: "POST", ClientRequestURI: "/login", ClientRequestUserAgent: "Go-http-client/2.0", EdgeResponseStatus: 403, RayID: "8c1f2e3d4c5b6a79", RequestHeaders: {} }));
  truth.splice(100, 0, [{ ok: true, method: "POST", target: "/login", status: 403, ua: "Go-http-client/2.0", class: "SUSPECTED", signal: "go-http-client", kind: "login" }]);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, 90);
  truth[truth.length - 1] = [{ ok: false }];
  return write("20260929T000000Z_20260930T000000Z_4c1f2e3d.log.gz", { vendor: "cloudflare", format: "cloudflare", gzip: true, truncatedLast: true }, lines, truth, reqs, { ips: ["2001:db8:cf::1"] });
}

// ── Vercel log drain (NDJSON; build logs; several entries per function request; arrays) ───
function vercel() {
  const { r, reqs } = traffic({ seed: 606, n: 300 });
  const lines = [], truth = [];
  const base = (q, source, extra = {}) => ({ id: `${q.ts}${int(r, 100000, 999999)}`, deploymentId: "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", source, host: "my-app-abc123.vercel.app",
    timestamp: q.ts, projectId: "gdufoJxB6b9b1fEqr1jUtFkyavUU", level: "info", environment: "production", ...extra });
  const proxy = (q, extra = {}) => ({ timestamp: q.ts, method: q.method, host: "www.example.com", path: q.target, userAgent: q.ua ? [q.ua] : [],
    referer: q.referer || undefined, region: "hnd1", statusCode: q.status, clientIp: q.ip, scheme: "https", ...extra });
  // docs examples, verbatim
  lines.push(`{"id": "1573817187330377061717300000","deploymentId": "dpl_233NRGRjVZX1caZrXWtz5g1TAksD","source": "build","host": "my-app-abc123.vercel.app","timestamp": 1573817187330,"projectId": "gdufoJxB6b9b1fEqr1jUtFkyavUU","level": "info","message": "Build completed successfully","buildId": "bld_cotnkcr76","type": "stdout","projectName": "my-app"}`);
  truth.push([]);
  lines.push(`{"id": "1573817250283254651097202070","deploymentId": "dpl_233NRGRjVZX1caZrXWtz5g1TAksD","source": "lambda","host": "my-app-abc123.vercel.app","timestamp": 1573817250283,"projectId": "gdufoJxB6b9b1fEqr1jUtFkyavUU","level": "info","message": "API request processed","entrypoint": "api/index.js","requestId": "643af4e3-975a-4cc7-9e7a-1eda11539d90","statusCode": 200,"path": "/api/users","executionRegion": "sfo1","environment": "production","traceId": "1b02cd14bb8642fd092bc23f54c7ffcd","spanId": "f24e8631bd11faa7","trace.id": "1b02cd14bb8642fd092bc23f54c7ffcd","span.id": "f24e8631bd11faa7","proxy": {"timestamp": 1573817250172,"method": "GET","host": "my-app.vercel.app","path": "/api/users?page=1","userAgent": ["Mozilla/5.0..."],"referer": "https://my-app.vercel.app","region": "sfo1","statusCode": 200,"clientIp": "120.75.16.101","scheme": "https","vercelCache": "MISS"}}`);
  truth.push([{ ok: true, method: "GET", target: "/api/users?page=1", status: 200, ua: "Mozilla/5.0...", class: "UNKNOWN", kind: "api" }]);
  let i = 0;
  for (const q of reqs) {
    i++;
    if (i % 40 === 0) { lines.push(JSON.stringify(base(q, "build", { message: `Compiled ${i} pages`, buildId: "bld_cotnkcr76", type: "stdout" }))); truth.push([]); }
    const kindOfSource = q.target.startsWith("/api/") || q.method !== "GET" ? "lambda" : q.kind === "asset" ? "static" : q.status === 403 ? "firewall" : "static";
    if (kindOfSource === "lambda") {
      const requestId = `${chars(r, 8, HEX)}-${chars(r, 4, HEX)}-4${chars(r, 3, HEX)}-a${chars(r, 3, HEX)}-${chars(r, 12, HEX)}`;
      const p = proxy(q, { pathType: "func" });
      lines.push(JSON.stringify(base(q, "lambda", { message: `${q.method} handled`, entrypoint: "api/index.js", requestId, statusCode: q.status, path: "/api/[...route]", proxy: p })));
      truth.push([good(q)]);
      lines.push(JSON.stringify(base(q, "lambda", { message: "db query 12ms", requestId, statusCode: q.status, proxy: p, type: "stdout" })));
      truth.push([]); // same request, second console line
    } else {
      lines.push(JSON.stringify(base(q, kindOfSource, { statusCode: q.status, proxy: proxy(q, kindOfSource === "firewall" ? { wafAction: "deny", wafRuleId: "rule_gAHz8jtSB1Gy" } : { vercelCache: "HIT", pathType: "static" }) })));
      truth.push([good(q)]);
    }
  }
  // The JSON delivery format: one POST body, an array of entries, on one line.
  const [a, b, c] = reqs.slice(10, 13).map((q) => ({ ...q, ts: q.ts + 1 }));
  lines.splice(30, 0, JSON.stringify([base(a, "static", { proxy: proxy(a) }), base(b, "build", { message: "cache restored" }), base(c, "static", { proxy: proxy(c) })]));
  truth.splice(30, 0, [good(a), good(c)]);
  const last = lines.pop(); truth.pop();
  lines.push(last.slice(0, Math.floor(last.length / 2)));
  truth.push([{ ok: false }]);
  return write("vercel-drain.ndjson", { vendor: "vercel", format: "vercel", truncatedLast: true }, lines, truth, reqs, { ips: ["120.75.16.101"] });
}

// ── AWS ALB (gzip; the node IP and account in the file name) ─────────────────────────────
function alb() {
  const { r, reqs } = traffic({ seed: 707, n: 300 });
  const lines = [], truth = [];
  const docs = [
    [`http 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.000 0.001 0.000 200 200 34 366 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.46.0" - - arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337262-36d228ad5d99923122bbe354" "-" "-" 0 2018-07-02T22:22:48.364000Z "forward" "-" "-" "10.0.0.1:80" "200" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 200, "curl/7.46.0"],
    [`https 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.086 0.048 0.037 200 200 0 57 "GET https://www.example.com:443/ HTTP/1.1" "curl/7.46.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337281-1d84f3d73c47ec4e58577259" "www.example.com" "arn:aws:acm:us-east-2:123456789012:certificate/12345678-1234-1234-1234-123456789012" 1 2018-07-02T22:22:48.364000Z "authenticate,forward" "-" "-" "10.0.0.1:80" "200" "-" "-" TID_1234abcd5678ef90 "m.example.com" "-" "TransformSuccess"`, 200, "curl/7.46.0"],
    [`h2 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 10.0.1.252:48160 10.0.0.66:9000 0.000 0.002 0.000 200 200 5 257 "GET https://10.0.2.105:773/ HTTP/2.0" "curl/7.46.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337327-72bd00b0343d75b906739c42" "-" "-" 1 2018-07-02T22:22:48.364000Z "redirect" "https://example.com:80/" "-" "10.0.0.66:9000" "200" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 200, "curl/7.46.0"],
    [`ws 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 10.0.0.140:40914 10.0.1.192:8010 0.001 0.003 0.000 101 101 218 587 "GET http://10.0.0.30:80/ HTTP/1.1" "-" - - arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 1 2018-07-02T22:22:48.364000Z "forward" "-" "-" "10.0.1.192:8010" "101" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 101, ""],
    [`wss 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 10.0.0.140:44244 10.0.0.171:8010 0.000 0.001 0.000 101 101 218 786 "GET https://10.0.0.30:443/ HTTP/1.1" "-" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 1 2018-07-02T22:22:48.364000Z "forward" "-" "-" "10.0.0.171:8010" "101" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 101, ""],
    [`http 2018-11-30T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 - 0.000 0.001 0.000 200 200 34 366 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.46.0" - - arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 0 2018-11-30T22:22:48.364000Z "forward" "-" "-" "-" "-" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 200, "curl/7.46.0"],
    [`http 2018-11-30T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 - 0.000 0.001 0.000 502 - 34 366 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.46.0" - - arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 0 2018-11-30T22:22:48.364000Z "forward" "-" "LambdaInvalidResponse" "-" "-" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`, 502, "curl/7.46.0"],
  ];
  for (const [line, status, ua] of docs) {
    lines.push(line);
    truth.push([ua ? { ok: true, method: "GET", target: "/", status, ua, class: "SUSPECTED", signal: "curl/", kind: "browse" }
      : { ok: true, method: "GET", target: "/", status, ua: "", class: "SUSPECTED", signal: "missing-user-agent", kind: "browse" }]);
  }
  for (const q of reqs) {
    const type = pick(r, ["https", "h2", "https", "http"]);
    const port = type === "http" ? 80 : 443;
    const client = q.ip.includes(":") ? `${q.ip}:${int(r, 1024, 65535)}` : `${q.ip}:${int(r, 1024, 65535)}`;
    const t = iso(q.ts).replace("Z", `${int(r, 100, 999)}Z`);
    lines.push(`${type} ${t} app/my-loadbalancer/50dc6c495c0c9188 ${client} 10.0.0.1:80 0.000 0.00${int(r, 1, 9)} 0.000 ${q.status} ${q.status} ${int(r, 30, 900)} ${q.bytes} "${escAlb(`${q.method} ${type === "http" ? "http" : "https"}://www.example.com:${port}${q.target} HTTP/${type === "h2" ? "2.0" : "1.1"}`)}" "${escAlb(q.ua || "-")}" ${type === "http" ? "- -" : "ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2"} arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-${chars(r, 8, HEX)}-${chars(r, 24, HEX)}" "www.example.com" "-" 0 ${t} "forward" "-" "-" "10.0.0.1:80" "${q.status}" "-" "-" TID_${chars(r, 16, HEX)} "-" "-" "-" 10.0.0.9`);
    truth.push([good(q)]);
  }
  // A request the load balancer could not parse.
  lines.splice(50, 0, `https 2026-09-29T09:00:00.000000Z app/my-loadbalancer/50dc6c495c0c9188 198.18.9.9:40000 - -1 -1 -1 400 - 0 272 "- - - " "-" - - - "-" "-" "-" - 2026-09-29T09:00:00.000000Z "-" "-" "-" "-" "-" "-" "-" TID_00000000000000aa "-" "-" "-"`);
  truth.splice(50, 0, [{ ok: true, method: null, target: null, status: 400, ua: "", class: "SUSPECTED", signal: "missing-user-agent", kind: "malformed" }]);
  const lastQ = reqs[reqs.length - 1];
  void lastQ;
  lines[lines.length - 1] = truncate(lines[lines.length - 1]);
  truth[truth.length - 1] = [{ ok: false }];
  const name = "123456789012_elasticloadbalancing_us-east-2_app.my-loadbalancer.1234567890abcdef_20260929T2340Z_172.160.001.192_20sg8hgm.log.gz";
  return write(name, { vendor: "aws-alb", format: "alb", gzip: true, truncatedLast: true }, lines, truth, reqs,
    { ips: ["192.168.131.39", "10.0.0.1", "10.0.1.252", "10.0.2.105", "10.0.0.140", "10.0.0.30", "10.0.0.66", "10.0.0.171", "10.0.1.192", "198.18.9.9", "172.160.001.192", "172.160.1.192", "10.0.0.9"], other: ["123456789012"] });
}

// ── CloudFront standard (legacy) logs (TSV, #Fields, URL-encoded UA, gzip) ────────────────
function cloudfront() {
  const { r, reqs } = traffic({ seed: 808, n: 300 });
  const header = [
    "#Version: 1.0",
    "#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status cs(Referer) cs(User-Agent) cs-uri-query cs(Cookie) x-edge-result-type x-edge-request-id x-host-header cs-protocol cs-bytes time-taken x-forwarded-for ssl-protocol ssl-cipher x-edge-response-result-type cs-protocol-version fle-status fle-encrypted-fields c-port time-to-first-byte x-edge-detailed-result-type sc-content-type sc-content-len sc-range-start sc-range-end",
  ];
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36";
  const docs = [
    ["2019-12-04\t21:02:31\tLAX1\t392\t192.0.2.100\tGET\td111111abcdef8.cloudfront.net\t/index.html\t200\t-\tMozilla/5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/78.0.3904.108%20Safari/537.36\t-\t-\tHit\tSOX4xwn4XV6Q4rgb7XiVGOHms_BGlTAC4KyHmureZmBNrjGdRLiNIQ==\td111111abcdef8.cloudfront.net\thttps\t23\t0.001\t-\tTLSv1.2\tECDHE-RSA-AES128-GCM-SHA256\tHit\tHTTP/2.0\t-\t-\t11040\t0.001\tHit\ttext/html\t78\t-\t-", "/index.html", 200, chrome, "UNKNOWN", "browse"],
    ["2019-12-04\t21:02:31\tLAX1\t392\t192.0.2.100\tGET\td111111abcdef8.cloudfront.net\t/index.html\t200\t-\tMozilla/5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/78.0.3904.108%20Safari/537.36\t-\t-\tHit\tk6WGMNkEzR5BEM_SaF47gjtX9zBDO2m349OY2an0QPEaUum1ZOLrow==\td111111abcdef8.cloudfront.net\thttps\t23\t0.000\t-\tTLSv1.2\tECDHE-RSA-AES128-GCM-SHA256\tHit\tHTTP/2.0\t-\t-\t11040\t0.000\tHit\ttext/html\t78\t-\t-", "/index.html", 200, chrome, "UNKNOWN", "browse"],
    ["2019-12-04\t21:02:31\tLAX1\t392\t192.0.2.100\tGET\td111111abcdef8.cloudfront.net\t/index.html\t200\t-\tMozilla/5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/78.0.3904.108%20Safari/537.36\t-\t-\tHit\tf37nTMVvnKvV2ZSvEsivup_c2kZ7VXzYdjC-GUQZ5qNs-89BlWazbw==\td111111abcdef8.cloudfront.net\thttps\t23\t0.001\t-\tTLSv1.2\tECDHE-RSA-AES128-GCM-SHA256\tHit\tHTTP/2.0\t-\t-\t11040\t0.001\tHit\ttext/html\t78\t-\t-\t", "/index.html", 200, chrome, "UNKNOWN", "browse"],
    ["2019-12-13\t22:36:27\tSEA19-C1\t900\t192.0.2.200\tGET\td111111abcdef8.cloudfront.net\t/favicon.ico\t502\thttp://www.example.com/\tMozilla/5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/78.0.3904.108%20Safari/537.36\t-\t-\tError\t1pkpNfBQ39sYMnjjUQjmH2w1wdJnbHYTbag21o_3OfcQgPzdL2RSSQ==\twww.example.com\thttp\t675\t0.102\t-\t-\t-\tError\tHTTP/1.1\t-\t-\t25260\t0.102\tOriginDnsError\ttext/html\t507\t-\t-", "/favicon.ico", 502, chrome, "UNKNOWN", "asset"],
    ["2019-12-13\t22:36:26\tSEA19-C1\t900\t192.0.2.200\tGET\td111111abcdef8.cloudfront.net\t/\t502\t-\tMozilla/5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/78.0.3904.108%20Safari/537.36\t-\t-\tError\t3AqrZGCnF_g0-5KOvfA7c9XLcf4YGvMFSeFdIetR1N_2y8jSis8Zxg==\twww.example.com\thttp\t735\t0.107\t-\t-\t-\tError\tHTTP/1.1\t-\t-\t3802\t0.107\tOriginDnsError\ttext/html\t507\t-\t-", "/", 502, chrome, "UNKNOWN", "browse"],
    ["2019-12-13\t22:37:02\tSEA19-C2\t900\t192.0.2.200\tGET\td111111abcdef8.cloudfront.net\t/\t502\t-\tcurl/7.55.1\t-\t-\tError\tkBkDzGnceVtWHqSCqBUqtA_cEs2T3tFUBbnBNkB9El_uVRhHgcZfcw==\twww.example.com\thttp\t387\t0.103\t-\t-\t-\tError\tHTTP/1.1\t-\t-\t12644\t0.103\tOriginDnsError\ttext/html\t507\t-\t-", "/", 502, "curl/7.55.1", "SUSPECTED", "browse", "curl/"],
  ];
  const lines = [...header], truth = [[], []];
  for (const [line, target, status, ua, cls, kind, signal] of docs) {
    lines.push(line);
    truth.push([{ ok: true, method: "GET", target, status, ua, class: cls, kind, signal }]);
  }
  for (const q of reqs) {
    const [stem, query] = q.target.split(/\?(.*)/s);
    q.xff = r() < 0.15 ? ip(r) : "";
    const d = iso(q.ts);
    const st = q.status === 404 && r() < 0.3 ? 0 : q.status; // 000: viewer closed the connection
    lines.push([d.slice(0, 10), d.slice(11, 19), "NRT57-P2", q.bytes, q.ip, q.method, "d111111abcdef8.cloudfront.net", stem, String(st).padStart(3, "0"),
      q.referer ? cfEncode(q.referer) : "-", q.ua ? cfEncode(q.ua) : "-", query ? query : "-", q.cookie ? cfEncode(q.cookie) : "-",
      "Miss", chars(r, 56, ALNUM) + "==", "www.example.com", "https", int(r, 100, 900), "0.0" + int(r, 10, 99), q.xff || "-", "TLSv1.3", "TLS_AES_128_GCM_SHA256", "Miss",
      "HTTP/2.0", "-", "-", int(r, 1024, 65535), "0.0" + int(r, 10, 99), "Miss", "text/html", q.bytes, "-", "-"].join("\t"));
    truth.push([good(q, { target: stem + (query ? `?${query}` : ""), status: st })]);
  }
  const lastQ = reqs[reqs.length - 1];
  lines[lines.length - 1] = lines[lines.length - 1].split("\t").slice(0, 12).join("\t");
  truth[truth.length - 1] = [{ ok: false }];
  void lastQ;
  return write("E2EXAMPLE123ABC.2026-09-29-00.a1b2c3d4.gz", { vendor: "aws-cloudfront", format: "cloudfront", gzip: true, truncatedLast: true }, lines, truth, reqs, { ips: ["192.0.2.100", "192.0.2.200"] });
}

// ── Fastly (Classic syslog prefix + the JSON format from Fastly's logging docs) ────────────
function fastly() {
  const { r, reqs } = traffic({ seed: 909, n: 300 });
  const lines = [], truth = [];
  for (const q of reqs) {
    const ts = isoSec(q.ts).replace("Z", "+0000");
    const o = { timestamp: ts, client_ip: q.ip, geo_country: "japan", geo_city: "tokyo", host: "www.example.com", url: q.target,
      request_method: q.method, request_protocol: "HTTP/2", request_referer: q.referer || "(null)", request_user_agent: q.ua || "(null)",
      response_state: pick(r, ["HIT", "MISS", "PASS"]), response_status: q.status, response_reason: null, response_body_size: q.bytes,
      fastly_server: "cache-nrt-rjtf7700046-NRT", fastly_is_edge: true };
    lines.push(`<134>${isoSec(q.ts)} cache-nrt-rjtf7700046 ludion-json[423156]: ${JSON.stringify(o)}`);
    truth.push([good(q)]);
  }
  const last = lines.pop(); truth.pop();
  lines.push(last.slice(0, last.length - 40));
  truth.push([{ ok: false }]);
  return write("fastly-json.log", { vendor: "fastly", format: "fastly", truncatedLast: true }, lines, truth, reqs, {});
}

// ── IIS W3C (BOM, CRLF, `+` for spaces, fields re-declared after a restart) ───────────────
function iis() {
  const { r, reqs } = traffic({ seed: 1010, n: 300 });
  const plus = (s) => (s ? s.replace(/ /g, "+") : "-");
  const unplus = (s) => (s ? s.replace(/\+/g, " ") : "");
  const lines = [
    // Microsoft docs example, verbatim (HTTP Server API)
    "#Software: Microsoft HTTP Server API 2.0",
    "#Version: 1.0",
    "#Date: 2002-05-02 17:42:15",
    "#Fields: date time c-ip cs-username s-ip s-port cs-method cs-uri-stem cs-uri-query sc-status cs(User-Agent)",
    "2002-05-02 17:42:15 172.22.255.255 - 172.30.255.255 80 GET /images/picture.jpg - 200 Mozilla/4.0+(compatible;MSIE+5.5;+Windows+2000+Server)",
    "#Software: Microsoft Internet Information Services 10.0",
    "#Version: 1.0",
    "#Date: 2026-09-29 00:00:00",
    "#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken",
  ];
  const truth = [[], [], [], [], [{ ok: true, method: "GET", target: "/images/picture.jpg", status: 200, ua: "Mozilla/4.0 (compatible;MSIE 5.5; Windows 2000 Server)", class: "UNKNOWN", kind: "asset" }], [], [], [], []];
  let restarted = false;
  reqs.forEach((q, i) => {
    const [stem, query] = q.target.split(/\?(.*)/s);
    const d = iso(q.ts);
    if (i === 150) {
      restarted = true;
      lines.push("#Software: Microsoft Internet Information Services 10.0", "#Version: 1.0", `#Date: ${d.slice(0, 10)} ${d.slice(11, 19)}`,
        "#Fields: date time s-sitename s-computername s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs-version cs(User-Agent) cs(Cookie) cs(Referer) cs-host sc-status sc-substatus sc-win32-status sc-bytes cs-bytes time-taken");
      truth.push([], [], [], []);
    }
    const user = r() < 0.05 ? `EXAMPLE\\${chars(r, 6, LOWER)}` : "-";
    if (user !== "-") q.canaries.seg.push(user.split("\\")[1]);
    const common = [d.slice(0, 10), d.slice(11, 19)];
    const row = restarted
      ? [...common, "W3SVC1", "WEB01", "10.0.0.4", q.method, stem, query || "-", "443", user, q.ip, "HTTP/2", plus(q.ua), q.cookie ? plus(q.cookie) : "-", q.referer ? plus(q.referer) : "-", "www.example.com", q.status, "0", "0", q.bytes, int(r, 200, 900), int(r, 1, 900)]
      : [...common, "10.0.0.4", q.method, stem, query || "-", "443", user, q.ip, plus(q.ua), q.referer ? plus(q.referer) : "-", q.status, "0", "0", int(r, 1, 900)];
    lines.push(row.join(" "));
    truth.push([good(q, { target: stem + (query ? `?${query}` : ""), ua: q.ua ? unplus(plus(q.ua)) : "" })]);
  });
  lines[lines.length - 1] = lines[lines.length - 1].split(" ").slice(0, 9).join(" ");
  truth[truth.length - 1] = [{ ok: false }];
  return write("u_ex260929.log", { vendor: "iis", format: "iis", crlf: true, bom: true, truncatedLast: true }, lines, truth, reqs, { ips: ["172.22.255.255", "172.30.255.255", "10.0.0.4"] });
}

for (const d of ["corpus", "truth"]) { fs.rmSync(path.join(DIR, d), { recursive: true, force: true }); fs.mkdirSync(path.join(DIR, d), { recursive: true }); }
const all = [nginx(), apacheCombined(), apacheCommon(), caddy(), cloudflare(), vercel(), alb(), cloudfront(), fastly(), iis()];
if (OUT < 0) for (const t of all) console.log(`${t.file.padEnd(40).slice(0, 60)} ${t.format.padEnd(11)} records ${String(t.records).padStart(4)}  parsed ${String(t.parsed).padStart(4)}  non-requests ${t.non_requests}`);
