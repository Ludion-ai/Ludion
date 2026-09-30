// The egress watch for the site oracles (WEB-6; WEB-5 next). Chromium is launched with this proxy
// as its only way out, loopback included (Playwright adds `<-loopback>` to the bypass list): the
// proxy serves the built site at its own origin and refuses everything else, recording every
// attempt. So a page under test reaches nothing but the site, even when it misbehaves, and whatever
// it tried is on the record. `judge` reads the record; it knows nothing about Chromium.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { resolveFile, TYPES } from "../serve.mjs";

/**
 * Start the proxy. `transform(rel, bytes)` may rewrite a site file as it is served (the planted
 * leaks of the self-test); `rel` is the dist-relative path with "/" separators.
 * @returns {Promise<{ origin: string, seen: object[], transform: Function|null, close: () => Promise<void> }>}
 */
export async function startEgressProxy(root) {
  root = path.resolve(root);
  const state = { origin: "", seen: [], transform: null };
  const record = (e) => state.seen.push({ source: "proxy", headers: {}, body: Buffer.alloc(0), ...e });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      // A request that went through a proxy names its target in absolute form; origin form means
      // the browser connected here directly, past the proxy settings: then the watch is not whole.
      const proxied = /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url ?? "");
      let url = null;
      try { url = new URL(req.url, state.origin); } catch { /* recorded as it came */ }
      record({ method: req.method, url: url?.href ?? String(req.url), proxied, headers: { ...req.headers }, body: Buffer.concat(chunks) });
      if (!url || url.origin !== state.origin) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        return res.end("refused by the egress watch\n");
      }
      const file = resolveFile(root, url.pathname);
      const served = file ?? path.join(root, "404.html");
      let bytes = fs.readFileSync(served);
      if (state.transform) bytes = state.transform(path.relative(root, served).split(path.sep).join("/"), bytes) ?? bytes;
      const type = TYPES[path.extname(served)] ?? "application/octet-stream";
      // The code the page runs is kept with its request: judge reads it for transports the proxy cannot see.
      if (/javascript|html/.test(type)) state.seen.at(-1).served = { type, text: bytes.toString("utf8") };
      // no-store: every fetch the page makes comes back here, none is answered from a cache.
      res.writeHead(file ? 200 : 404, { "content-type": type, "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    });
  });
  // https:// and ws(s):// through an HTTP proxy are tunnels: the target is all there is to record.
  server.on("connect", (req, socket) => {
    socket.on("error", () => {});
    record({ method: "CONNECT", url: String(req.url), proxied: true, headers: { ...req.headers } });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    record({ method: "UPGRADE", url: String(req.url), proxied: /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url ?? ""), headers: { ...req.headers } });
    socket.destroy();
  });
  server.on("clientError", (e, socket) => {
    if (/^HPE_/.test(e.code ?? "")) record({ method: "?", url: `(unparsable request: ${e.code})`, proxied: false });
    socket.destroy();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get origin() { return state.origin; },
    get seen() { return state.seen; },
    set seen(v) { state.seen = v; },
    get transform() { return state.transform; },
    set transform(f) { state.transform = f; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/**
 * What the canary looks like wherever it may travel: as written (any case), hex-encoded, and in
 * base64 and base64url at each of the three byte alignments (only the characters that depend on
 * the canary alone, so it is found inside any longer run of encoded bytes).
 */
export function canaryForms(canary) {
  const b = Buffer.from(canary);
  const forms = new Set([canary.toLowerCase(), b.toString("hex")]);
  for (let pad = 0; pad < 3; pad++) {
    const s = Buffer.concat([Buffer.alloc(pad), b]).toString("base64");
    const mid = s.slice(pad ? 4 : 0, -4);
    forms.add(mid);
    forms.add(mid.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...forms];
}

const decoded = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };

/** Whether `data` (string or bytes, gzip is opened) carries any of the canaries. */
export function carries(data, canaries) {
  if (data == null) return false;
  let texts;
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    const buf = Buffer.from(data);
    texts = [buf.toString("latin1")];
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { texts.push(zlib.gunzipSync(buf).toString("latin1")); } catch { /* not whole */ } }
  } else texts = [String(data)];
  texts = texts.flatMap((t) => [t, decoded(t)]);
  return canaries.some((c) => {
    const forms = canaryForms(c);
    return texts.some((t) => t.toLowerCase().includes(c.toLowerCase()) || forms.some((f) => t.includes(f)));
  });
}

const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

// Transports that go around an HTTP proxy (UDP: WebRTC, and WebTransport over QUIC) and that a
// page's request events do not report either. The site has no use for them, so the code it serves
// must not name them: that is the only way the watch can see them.
const UNWATCHABLE = /\b(?:webkit)?(?:RTCPeerConnection|RTCDataChannel|WebTransport)\b/;

/** The code in a served response: all of a script, the <script> elements of a page. */
function code({ type, text }) {
  if (/javascript/.test(type)) return text;
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
}

/**
 * The rules of the watch, over every request recorded (by the proxy and by the browser's own
 * request events). A page that keeps a log on the device makes only these: GET or HEAD of a file
 * the site ships, at the site's origin, with no query and no body, carrying no canary; and the
 * code it is served names no transport the watch cannot see.
 * @param {{ source: string, method: string, url: string, proxied?: boolean, headers?: object, body?: Buffer }[]} requests
 * @param {{ origin: string, root: string, canaries: string[] }} opts
 * @returns {{ rule: string, what: string }[]}
 */
export function judge(requests, { origin, root, canaries }) {
  const out = [];
  const flag = (rule, r) => out.push({ rule, what: `${r.source}: ${r.method} ${String(r.url).slice(0, 160)}` });
  for (const r of requests) {
    if (r.source === "proxy" && r.proxied === false) flag("unwatched", r);
    if (r.served && UNWATCHABLE.test(code(r.served))) flag("unwatched transport", r);
    const headers = Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
    if (carries(r.url, canaries) || carries(headers, canaries) || carries(r.body, canaries)) flag("canary", r);
    if (r.body?.length) flag("body", r);
    if (r.method === "CONNECT") { flag("outside", r); continue; }
    let u;
    try { u = new URL(r.url); } catch { flag("outside", r); continue; }
    if (LOCAL_SCHEMES.has(u.protocol)) continue;
    if (u.origin !== origin) { flag("outside", r); continue; }
    if (r.method !== "GET" && r.method !== "HEAD") flag("method", r);
    if (u.search) flag("query", r);
    if (!resolveFile(root, u.pathname)) flag("unknown file", r);
  }
  return out;
}
