// Known agent User-Agent tokens (DECLARED classification) and weak automation
// signals (SUSPECTED classification).
//
// Ludion does NOT compete on detection (spec §11.5). This list exists only so
// that a Pressure-0 report is never empty on day one. It is a starting set of
// tokens that the operators themselves publish in their crawler/agent docs.
// Update weekly from primary sources; entries marked TODO(verify) must be
// re-checked against the operator's own documentation before the public
// observation report (spec Day 28).
//
// Detection of unsigned agents is inherently spoofable. That is the point:
// only a valid Web Bot Auth signature moves a request to VERIFIED.

/** @type {{ token: string, operator: string, kind: "fetcher"|"crawler"|"search"|"unknown" }[]} */
export const KNOWN_AGENT_TOKENS = [
  // OpenAI
  { token: "ChatGPT-User", operator: "OpenAI", kind: "fetcher" },
  { token: "OAI-SearchBot", operator: "OpenAI", kind: "search" },
  { token: "GPTBot", operator: "OpenAI", kind: "crawler" },
  // Anthropic
  { token: "Claude-User", operator: "Anthropic", kind: "fetcher" },
  { token: "Claude-SearchBot", operator: "Anthropic", kind: "search" },
  { token: "ClaudeBot", operator: "Anthropic", kind: "crawler" },
  { token: "anthropic-ai", operator: "Anthropic", kind: "crawler" }, // TODO(verify) legacy token
  // Perplexity
  { token: "Perplexity-User", operator: "Perplexity", kind: "fetcher" },
  { token: "PerplexityBot", operator: "Perplexity", kind: "crawler" },
  // Google
  { token: "Google-Extended", operator: "Google", kind: "crawler" },
  { token: "Googlebot", operator: "Google", kind: "search" },
  { token: "GoogleOther", operator: "Google", kind: "crawler" },
  // Microsoft
  { token: "bingbot", operator: "Microsoft", kind: "search" },
  // Amazon
  { token: "Amazonbot", operator: "Amazon", kind: "crawler" },
  // Apple
  { token: "Applebot-Extended", operator: "Apple", kind: "crawler" },
  { token: "Applebot", operator: "Apple", kind: "search" },
  // Meta
  { token: "meta-externalagent", operator: "Meta", kind: "crawler" },
  { token: "meta-externalfetcher", operator: "Meta", kind: "fetcher" },
  { token: "FacebookBot", operator: "Meta", kind: "crawler" },
  // ByteDance
  { token: "Bytespider", operator: "ByteDance", kind: "crawler" },
  // Common Crawl
  { token: "CCBot", operator: "Common Crawl", kind: "crawler" },
  // DuckDuckGo
  { token: "DuckAssistBot", operator: "DuckDuckGo", kind: "fetcher" },
  { token: "DuckDuckBot", operator: "DuckDuckGo", kind: "search" },
  // Mistral
  { token: "MistralAI-User", operator: "Mistral", kind: "fetcher" }, // TODO(verify)
  // Cohere
  { token: "cohere-ai", operator: "Cohere", kind: "crawler" }, // TODO(verify)
  // You.com
  { token: "YouBot", operator: "You.com", kind: "search" }, // TODO(verify)
  // Diffbot
  { token: "Diffbot", operator: "Diffbot", kind: "crawler" },
  // Timpi / others deliberately omitted until verified.
];

/** Weak automation signals. Matching is case-insensitive substring. */
export const AUTOMATION_SIGNALS = [
  "python-requests", "python-urllib", "aiohttp", "httpx",
  "curl/", "wget/", "go-http-client", "okhttp", "java/", "apache-httpclient",
  "node-fetch", "undici", "axios/", "got (", "libwww-perl", "ruby",
  "scrapy", "crawl4ai", "colly", "puppeteer", "playwright", "selenium",
  "headlesschrome", "phantomjs", "electron",
];

/**
 * Match a User-Agent string against known agent tokens.
 * @param {string|undefined} ua
 * @returns {{ token: string, operator: string, kind: string } | null}
 */
export function matchKnownAgent(ua) {
  if (!ua) return null;
  for (const entry of KNOWN_AGENT_TOKENS) {
    if (ua.includes(entry.token)) return entry;
  }
  return null;
}

/**
 * @param {string|undefined} ua
 * @returns {string|null} the matched signal, or null
 */
export function matchAutomationSignal(ua) {
  if (!ua) return "missing-user-agent";
  const l = ua.toLowerCase();
  for (const s of AUTOMATION_SIGNALS) if (l.includes(s)) return s;
  return null;
}
