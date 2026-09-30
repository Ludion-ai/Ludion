// Log formats. Each parser turns one line into zero or more request records:
//   emit(record)  a request it understood: { method, target, status, ua, ts, ip, signed }
//   emit(false)   a request line it could not parse (counts against the parse rate)
//   nothing       not a request at all: format directives, build logs, other loggers
// The parse rate's denominator is exactly the emitted records (good + false).
//
// `ua` is a string when the format records the User-Agent ("" when the client sent none) and
// undefined when the format has no User-Agent field at all (Apache common): those are not
// "missing UA" automation, they are unknowable.
//
// Field layouts follow each vendor's documentation (see accept/fixtures/logs/README.md).

const Q = String.raw`"([^"\\]*(?:\\.[^"\\]*)*)"`;
const CLF = new RegExp(String.raw`^(\S+) (\S+) (\S+) \[([^\]]+)\] ${Q} (\d{3}|-) (\S+)(?: ${Q} ${Q})?`);
const VHOST = /^(\S+?:\d+) (?=\S+ \S+ \S+ \[)/;
const TOKENS = new RegExp(String.raw`${Q}|(\S+)`, "g");
const METHOD = /^[A-Z][A-Z_-]{0,19}$/;
const HTTP_VERSION = /^HTTP\/\d(?:\.\d)?$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const UTF8 = new TextDecoder("utf-8");

/** Apache `\"` `\\` and nginx/apache `\xHH` escapes inside quoted fields (byte runs are UTF-8). */
export function unescapeLogString(s) {
  if (!s.includes("\\")) return s;
  return s.replace(/((?:\\x[0-9A-Fa-f]{2})+)|\\(.)/g, (_, hex, ch) => {
    if (ch !== undefined) return ch;
    const bytes = Uint8Array.from(hex.match(/[0-9A-Fa-f]{2}/g), (h) => parseInt(h, 16));
    return UTF8.decode(bytes);
  });
}

/** `GET /path?q HTTP/1.1` → { method, target }. Garbage or `-` → nulls (still a record). */
export function splitRequestLine(r) {
  if (!r || r === "-") return { method: null, target: null };
  const parts = r.split(" ");
  let method = parts[0], target = null;
  if (parts.length >= 3 && HTTP_VERSION.test(parts[parts.length - 1])) target = parts.slice(1, -1).join(" ");
  else if (parts.length === 2) target = parts[1];
  if (!METHOD.test(method) || !target) return { method: null, target: null };
  return { method, target };
}

/** `30/Sep/2026:08:00:00 +0900` → epoch ms. */
function clfTime(s) {
  const m = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?$/.exec(s);
  if (!m || !(m[2] in MONTHS)) return null;
  const off = m[7] ? (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) : 0;
  return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]) - off * 60_000;
}

/** ISO-ish strings, including strftime `%z` offsets without a colon. */
function isoTime(s) {
  if (typeof s !== "string") return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? t : null;
}

/** Epoch in s, ms, µs or ns → ms. */
function epoch(n) {
  if (typeof n === "string") return /^\d+(\.\d+)?$/.test(n) ? epoch(Number(n)) : isoTime(n);
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n > 1e17) return Math.floor(n / 1e6);
  if (n > 1e14) return Math.floor(n / 1e3);
  if (n > 1e11) return Math.floor(n);
  return Math.floor(n * 1000);
}

const status = (v) => (v == null || v === "-" || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Header lookup in `{ Name: value | [values] }`, case-insensitive. */
function header(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) {
    const v = headers[k];
    return Array.isArray(v) ? (v.length ? String(v[0]) : "") : String(v);
  }
  return undefined;
}
const WBA_HEADERS = ["signature-input", "signature", "signature-agent"];
const hasSignature = (headers) => WBA_HEADERS.some((h) => header(headers, h) !== undefined);

// ── syslog framing (Fastly "Classic"/RFC 3164, RFC 5424 / "Loggly", "Logplex") ────────────
const SYSLOG_3164 = /^<\d{1,3}>(?:[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\S+) \S+ [^:\s[]+(?:\[\d+\])?: ?/;
const SYSLOG_5424 = /^<\d{1,3}>1 \S+ \S+ \S+ \S+ \S+ (?:-|(?:\[[^\]\\]*(?:\\.[^\]\\]*)*\])+) ?/;
/** Strip a syslog prefix if the line has one. */
export function stripSyslog(line) {
  if (line.charCodeAt(0) !== 60) return line;
  const m = SYSLOG_5424.exec(line) ?? SYSLOG_3164.exec(line);
  return m ? line.slice(m[0].length) : line;
}

// ── parsers ────────────────────────────────────────────────────────────────────────────────

function clfParser(id, { requireUa, vhost }) {
  return {
    id,
    parse(line, emit) {
      let l = line;
      if (vhost) { const v = VHOST.exec(l); if (!v) return emit(false); l = l.slice(v[0].length); }
      const m = CLF.exec(l);
      if (!m || (requireUa && m[9] === undefined)) return emit(false);
      const { method, target } = splitRequestLine(unescapeLogString(m[5]));
      const ua = m[9] === undefined ? undefined : unescapeLogString(m[9]);
      emit({ method, target, status: status(m[6]), ua: ua === "-" ? "" : ua, ts: clfTime(m[4]), ip: m[1], signed: false });
    },
  };
}

const ALB_TYPES = new Set(["http", "https", "h2", "grpcs", "ws", "wss"]);
function albParser() {
  return {
    id: "alb",
    parse(line, emit) {
      const t = [], quoted = [];
      TOKENS.lastIndex = 0;
      for (let m; (m = TOKENS.exec(line)) && t.length < 14;) { t.push(m[1] !== undefined ? m[1] : m[2]); quoted.push(m[1] !== undefined); }
      // request_line and user_agent are always quoted; an unterminated quote is a cut line.
      if (t.length < 14 || !quoted[12] || !quoted[13] || !ALB_TYPES.has(t[0]) || !/^\d{4}-\d\d-\d\dT/.test(t[1])) return emit(false);
      const req = unescapeLogString(t[12]);
      let { method, target } = splitRequestLine(req);
      if (target && !target.startsWith("/")) {
        const u = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(target);
        target = u ? (u[1] || "/") : target;
      }
      const client = t[3];
      const ip = client.startsWith("[") ? client.slice(1, client.indexOf("]")) : client.replace(/:\d+$/, "");
      const ua = unescapeLogString(t[13]);
      emit({ method, target, status: status(t[8]), ua: ua === "-" ? "" : ua, ts: isoTime(t[1]), ip, signed: false });
    },
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** W3C extended (CloudFront standard logs, IIS). Fields come from `#Fields:`; may change mid-file. */
function w3cParser() {
  let fields = null, idx = null, cloudfront = false, iis = false;
  return {
    id: "w3c",
    get label() { return cloudfront ? "cloudfront" : iis ? "iis" : "w3c"; },
    parse(line, emit) {
      if (line.charCodeAt(0) === 35) { // '#'
        const m = /^#([A-Za-z-]+):\s*(.*)$/.exec(line);
        if (!m) return;
        if (m[1] === "Fields") {
          fields = m[2].trim().split(/\s+/).map((f) => f.toLowerCase());
          idx = Object.fromEntries(fields.map((f, i) => [f, i]));
          if ("x-edge-location" in idx || "x-edge-request-id" in idx) cloudfront = true;
          else if ("s-sitename" in idx || "s-computername" in idx || "sc-win32-status" in idx || "sc-substatus" in idx) iis = true;
        } else if (m[1] === "Software" && /Microsoft/i.test(m[2])) iis = true;
        return;
      }
      if (!fields) return emit(false);
      const v = line.includes("\t") ? line.split("\t") : line.split(" ");
      // Every declared field must be there (extra trailing fields are fine: CloudFront adds them).
      if (v.length < fields.length || idx["cs-method"] === undefined || idx["cs-uri-stem"] === undefined) return emit(false);
      const get = (f) => (idx[f] !== undefined && idx[f] < v.length ? v[idx[f]] : undefined);
      const method = get("cs-method"), stem = get("cs-uri-stem"), query = get("cs-uri-query");
      if (!METHOD.test(method) || !stem) return emit(false);
      let ua = get("cs(user-agent)");
      if (ua !== undefined) ua = ua === "-" ? "" : cloudfront ? safeDecode(ua) : ua.replace(/\+/g, " ");
      const date = get("date"), time = get("time");
      const ts = date && time ? isoTime(`${date}T${time}Z`) : null;
      emit({ method, target: query && query !== "-" ? `${stem}?${query}` : stem, status: status(get("sc-status")), ua, ts, ip: get("c-ip") ?? null, signed: false });
    },
  };
}

function jsonParser(id, fromObject) {
  return {
    id,
    parse(line, emit) {
      const c = line.charCodeAt(0);
      if (c !== 123 && c !== 91) return emit(false); // '{' or '['
      let o;
      try { o = JSON.parse(line); } catch { return emit(false); }
      if (Array.isArray(o)) { for (const x of o) fromObject(x && typeof x === "object" ? x : null, emit); return; }
      fromObject(o, emit);
    },
  };
}

function caddyParser() {
  return jsonParser("caddy", (o, emit) => {
    if (!o) return emit(false);
    if (typeof o.logger !== "string" || !o.logger.startsWith("http.log.access")) return; // tls, admin, … not requests
    const r = o.request;
    if (!r || typeof r !== "object") return emit(false);
    const h = r.headers ?? {};
    const ua = r.headers ? (header(h, "user-agent") ?? "") : undefined;
    emit({ method: r.method ?? null, target: r.uri ?? null, status: status(o.status), ua, ts: epoch(o.ts), ip: r.client_ip ?? r.remote_ip ?? null, signed: hasSignature(h) });
  });
}

function cloudflareParser() {
  return jsonParser("cloudflare", (o, emit) => {
    if (!o) return emit(false);
    if (!("ClientRequestURI" in o || "ClientRequestPath" in o || "ClientRequestMethod" in o)) return;
    const target = o.ClientRequestURI ?? (o.ClientRequestPath != null ? `${o.ClientRequestPath}${o.ClientRequestQuery ? (String(o.ClientRequestQuery).startsWith("?") ? "" : "?") + o.ClientRequestQuery : ""}` : null);
    const ua = "ClientRequestUserAgent" in o ? String(o.ClientRequestUserAgent ?? "") : undefined;
    emit({ method: o.ClientRequestMethod ?? null, target, status: status(o.EdgeResponseStatus), ua, ts: epoch(o.EdgeStartTimestamp ?? o.Datetime), ip: o.ClientIP ?? null, signed: hasSignature(o.RequestHeaders) });
  });
}

function vercelParser() {
  let seen = new Set();
  return jsonParser("vercel", (o, emit) => {
    if (!o) return emit(false);
    if (!("deploymentId" in o && "source" in o)) return;
    const p = o.proxy;
    if (!p || typeof p !== "object") return; // build output, function console lines without a request
    // One request can produce several entries (each console line of a function carries the
    // same proxy object). Count it once, by requestId.
    if (o.requestId) {
      if (seen.has(o.requestId)) return;
      if (seen.size > 200_000) seen = new Set();
      seen.add(o.requestId);
    }
    const uaList = Array.isArray(p.userAgent) ? p.userAgent : p.userAgent != null ? [p.userAgent] : null;
    const ua = uaList ? (uaList.length ? String(uaList[0]) : "") : undefined;
    emit({ method: p.method ?? null, target: p.path ?? null, status: status(p.statusCode ?? o.statusCode), ua, ts: epoch(p.timestamp ?? o.timestamp), ip: p.clientIp ?? null, signed: false });
  });
}

/** Fastly JSON log lines using the field names of Fastly's documented JSON format example. */
function fastlyParser() {
  return jsonParser("fastly", (o, emit) => {
    if (!o) return emit(false);
    if (!("request_user_agent" in o || "fastly_server" in o || ("url" in o && "client_ip" in o))) return;
    // VCL logs an absent header as "(null)".
    const ua = "request_user_agent" in o ? (o.request_user_agent == null || o.request_user_agent === "(null)" ? "" : String(o.request_user_agent)) : undefined;
    emit({ method: o.request_method ?? o.method ?? null, target: o.url ?? null, status: status(o.response_status ?? o.status), ua, ts: isoTime(o.timestamp) ?? epoch(o.timestamp), ip: o.client_ip ?? null, signed: false });
  });
}

/** Generic JSON lines (nginx/Envoy/app loggers with common key names). */
function genericJsonParser() {
  const str = (...vs) => { for (const v of vs) if (typeof v === "string") return v; return undefined; };
  return jsonParser("json", (o, emit) => {
    if (!o) return emit(false);
    const request = typeof o.request === "string" ? splitRequestLine(o.request) : {};
    const method = str(o.method, o.request_method, o.http_method, request.method);
    const target = str(o.path, o.uri, o.request_uri, o.url, request.target);
    if (!method && !target) return;
    const uaRaw = str(o.user_agent, o.ua, o.http_user_agent, o.userAgent, o["user-agent"]);
    const hasUaKey = ["user_agent", "ua", "http_user_agent", "userAgent", "user-agent"].some((k) => k in o);
    emit({ method: method ?? null, target: target ?? null, status: status(o.status ?? o.status_code ?? o.response_status),
      ua: hasUaKey ? (uaRaw === "-" ? "" : uaRaw ?? "") : undefined, ts: isoTime(o.time ?? o.timestamp) ?? epoch(o.ts ?? o.time ?? o.timestamp),
      ip: str(o.ip, o.client_ip, o.remote_addr) ?? null, signed: hasSignature(o.headers) || typeof o.signature_agent === "string" });
  });
}

const FACTORIES = {
  w3c: w3cParser,
  alb: albParser,
  caddy: caddyParser,
  cloudflare: cloudflareParser,
  vercel: vercelParser,
  fastly: fastlyParser,
  "vhost-combined": () => clfParser("vhost-combined", { requireUa: true, vhost: true }),
  combined: () => clfParser("combined", { requireUa: true }),
  common: () => clfParser("common", { requireUa: false }),
  json: genericJsonParser,
};
/** Detection order doubles as the tie-break: most specific first. */
export const FORMAT_IDS = Object.keys(FACTORIES);

/** @param {string} id */
export function createParser(id) {
  const f = FACTORIES[id];
  if (!f) throw new Error(`unknown format ${id} (known: ${FORMAT_IDS.join(", ")})`);
  const p = f();
  let syslog = false;
  return {
    get id() { return p.label ?? p.id; },
    get syslog() { return syslog; },
    parse(line, emit) {
      const l = stripSyslog(line);
      if (l !== line) syslog = true;
      p.parse(l, emit);
    },
  };
}

/**
 * Pick the format that parses the most of a sample of lines. No flags needed.
 * @param {string[]} sample
 * @returns {string|null} format id, or null when nothing fits at least half of the records
 */
export function detectFormat(sample) {
  let best = null, bestOk = 0, bestRecords = 0;
  for (const id of FORMAT_IDS) {
    // Generic JSON only when no vendor format understands the file at all.
    if (id === "json" && best) break;
    const p = createParser(id);
    let ok = 0, records = 0;
    for (const line of sample) p.parse(line, (r) => { records++; if (r) ok++; });
    if (ok > bestOk) { best = id; bestOk = ok; bestRecords = records; }
  }
  return best && bestOk * 2 >= bestRecords ? best : null;
}
