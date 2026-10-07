import type { FetchFn } from "./teachers.ts";

export type SourceResult = { found: true } | { found: false; reason: string };

const USER_AGENT = "LudionBot/0.1 (+https://ludion.ai/bot)";
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;

// Latin-1 entity names, U+00A0 through U+00FF in order.
const LATIN1 = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para " +
  "middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute " +
  "Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute " +
  "THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde " +
  "ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");

const ENTITIES: Record<string, string> = {
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCodePoint(0xa0 + i)])),
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  hellip: "…", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", middot: "·", bull: "•",
  trade: "™", minus: "−", prime: "′", Prime: "″", zwj: "", zwnj: "", thinsp: " ", ensp: " ", emsp: " ",
};

// Tags that sit inside a run of text: remove them without a space, so "dist<b>utils</b>." stays "distutils.".
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "del", "ins",
]);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Normalization applied to both the page and the quote before matching. */
export function normalizeText(s: string): string {
  return decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_, tag: string) => (INLINE_TAGS.has(tag.toLowerCase()) ? "" : " ")),
  )
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BYTES - total;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    total += Math.min(value.length, room);
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const BLOCKED_NAMES = ["localhost", "local", "internal", "home.arpa", "test", "invalid", "example", "onion"];
const TEXT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);

/**
 * Why Ludion will not fetch this URL, or undefined if it may. Judged on the URL as parsed by `new URL()`,
 * which already rewrites decimal, hex, and octal IPv4 hosts to dotted form.
 * Names alone cannot show where DNS points; the caller's fetch must refuse private addresses too.
 */
export function sourceUrlProblem(url: URL): string | undefined {
  if (url.protocol !== "https:") return `${url.href} is not https. Link to an https:// page.`;
  if (url.username !== "" || url.password !== "") return "The link contains a user name or password. Link to a public page without them.";
  if (url.port !== "") return `The link uses port ${url.port}. Link to a page on the default https port.`;
  const host = url.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    return `The link points to the IP address ${host}. Link to a page by its domain name.`;
  }
  const name = host.replace(/\.$/, "");
  if (!name.includes(".") || BLOCKED_NAMES.some((b) => name === b || name.endsWith(`.${b}`))) {
    return `${host} is not a public domain name. Link to a page on the public web.`;
  }
  return undefined;
}

function parseUrl(raw: string, base?: URL): URL | undefined {
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
}

/**
 * Fetch `url` and report whether `quote` appears on it. Every hop is checked with sourceUrlProblem;
 * redirects are followed by hand, at most 3; only text pages are read, at most 2 MB, within 5 seconds.
 */
export async function checkSource(url: string, quote: string, fetchFn: FetchFn): Promise<SourceResult> {
  let current = parseUrl(url);
  if (!current) return { found: false, reason: `${url} is not a valid URL. Use a full https:// link.` };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const problem = sourceUrlProblem(current);
    if (problem) return { found: false, reason: hop === 0 ? problem : `${url} redirects to a page Ludion will not fetch: ${problem}` };
    let res: Response;
    try {
      res = await fetchFn(current.href, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      return {
        found: false,
        reason: signal.aborted
          ? `${current.host} did not answer within 5 seconds. Try again later, or cite a page that loads faster.`
          : `Could not reach ${current.host}${cause}. Check the URL.`,
      };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) {
        return { found: false, reason: `${url} redirects more than 3 times. Link to the final page instead.` };
      }
      const next = parseUrl(res.headers.get("location")!, current);
      if (!next) return { found: false, reason: `${url} redirects to an invalid address. Link to the final page instead.` };
      current = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { found: false, reason: `${current.host} answered HTTP ${res.status} for ${current.href}. Check the URL.` };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!TEXT_TYPES.has(type)) {
      await res.body?.cancel().catch(() => {});
      return { found: false, reason: `${current.href} is not a web page (content type "${type || "none"}"). Cite an HTML or plain-text page.` };
    }
    let page: string;
    try {
      page = await readCapped(res);
    } catch {
      return { found: false, reason: `${current.host} stopped sending the page. Try again later.` };
    }
    const needle = normalizeText(quote);
    if (needle.length > 0 && normalizeText(page).includes(needle)) return { found: true };
    return { found: false, reason: `That quote isn't on ${current.host}. Copy a sentence exactly as it appears on the page.` };
  }
}
