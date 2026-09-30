// The rules of the egress watch (WEB-6), without a browser: what the canary looks like on the way
// out, and which recorded requests a page that keeps a log on the device may make.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { canaryForms, carries, judge } from "./egress.mjs";

const CANARY = "3f9c2a7be41d5c08a6e17f2b9d0c4e51";

test("egress: the canary is found as written, in any case, hex-encoded, and in base64 at every alignment", () => {
  const line = `203.0.113.9 - - [30/Sep/2026:10:00:00 +0000] "GET /orders/${CANARY} HTTP/1.1" 200 1 "-" "curl/8"`;
  assert.ok(carries(line, [CANARY]));
  assert.ok(carries(line.toUpperCase(), [CANARY]));
  assert.ok(carries(Buffer.from(line).toString("hex"), [CANARY]));
  for (let pad = 0; pad < 3; pad++) {
    const text = "x".repeat(pad) + line;
    const b64 = Buffer.from(text).toString("base64");
    assert.ok(carries(`d=${b64}`, [CANARY]), `base64, offset ${pad}`);
    assert.ok(carries(`d=${Buffer.from(text).toString("base64url")}`, [CANARY]), `base64url, offset ${pad}`);
    assert.ok(carries(`/p?d=${encodeURIComponent(b64)}`, [CANARY]), `percent-encoded base64, offset ${pad}`);
  }
  assert.ok(carries(zlib.gzipSync(line), [CANARY]), "a gzip body is opened");
  assert.ok(carries(Buffer.from(`POST body ${CANARY}`), [CANARY]));
  assert.equal(canaryForms(CANARY).every((f) => f.length >= 32), true, "no form is short enough to match by chance");
  // Not found where it is not.
  assert.equal(carries(line.replace(CANARY, "0".repeat(32)), [CANARY]), false);
  assert.equal(carries(Buffer.from(line.replace(CANARY, "")).toString("base64"), [CANARY]), false);
  assert.equal(carries(null, [CANARY]), false);
});

test("egress: only a GET or HEAD of a shipped file, at the site's origin, with no query, no body, no canary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-egress-"));
  try {
    fs.mkdirSync(path.join(root, "_astro"));
    for (const f of ["index.html", "scan.html", "_astro/worker-X1.js", "favicon.svg"]) fs.writeFileSync(path.join(root, f), "x");
    const origin = "http://127.0.0.1:4321";
    const rules = (r) => judge([{ source: "proxy", proxied: true, headers: {}, body: Buffer.alloc(0), ...r }], { origin, root, canaries: [CANARY] }).map((v) => v.rule).sort();

    for (const url of [`${origin}/`, `${origin}/scan`, `${origin}/_astro/worker-X1.js`, `${origin}/favicon.svg`])
      for (const method of ["GET", "HEAD"]) assert.deepEqual(rules({ method, url }), [], `${method} ${url}`);
    for (const url of ["data:text/plain,hi", "blob:http://127.0.0.1:4321/0b5e", "about:blank"]) assert.deepEqual(rules({ source: "browser", method: "GET", url }), [], url);

    assert.deepEqual(rules({ method: "GET", url: "https://collect.example/p" }), ["outside"]);
    assert.deepEqual(rules({ method: "GET", url: "http://127.0.0.1:9999/" }), ["outside"], "another port is another origin");
    assert.deepEqual(rules({ method: "CONNECT", url: "collect.example:443" }), ["outside"]);
    assert.deepEqual(rules({ method: "GET", url: `${origin}/favicon.svg?d=1` }), ["query"]);
    assert.deepEqual(rules({ method: "GET", url: `${origin}/_astro/aGVsbG8.js` }), ["unknown file"]);
    assert.deepEqual(rules({ method: "GET", url: `${origin}/../../etc/passwd` }), ["unknown file"]);
    assert.deepEqual(rules({ method: "POST", url: `${origin}/`, body: Buffer.from("x") }), ["body", "method"]);
    assert.deepEqual(rules({ method: "PUT", url: `${origin}/scan` }), ["method"]);
    assert.deepEqual(rules({ method: "GET", url: `${origin}/`, headers: { "x-d": `v=${CANARY}` } }), ["canary"]);
    assert.deepEqual(rules({ method: "GET", url: `https://${CANARY}.collect.example/` }), ["canary", "outside"]);
    assert.deepEqual(rules({ method: "GET", url: `${origin}/`, proxied: false }), ["unwatched"], "past the proxy: the watch is not whole");
    assert.deepEqual(rules({ method: "GET", url: "not a url" }), ["outside"]);

    // Transports around the proxy: named in the code served, never in the page's prose.
    const js = (text) => ({ method: "GET", url: `${origin}/_astro/worker-X1.js`, served: { type: "text/javascript; charset=utf-8", text } });
    const html = (text) => ({ method: "GET", url: `${origin}/scan`, served: { type: "text/html; charset=utf-8", text } });
    assert.deepEqual(rules(js("const t = new WebTransport(u);")), ["unwatched transport"]);
    assert.deepEqual(rules(js("new self.RTCPeerConnection({})")), ["unwatched transport"]);
    assert.deepEqual(rules(js("x.webkitRTCPeerConnection")), ["unwatched transport"]);
    assert.deepEqual(rules(html('<p>WebRTC is not used.</p><script type="module">const pc = new RTCPeerConnection();</script>')), ["unwatched transport"]);
    assert.deepEqual(rules(html("<p>This page never opens a WebTransport or an RTCPeerConnection.</p><script>1</script>")), []);
    assert.deepEqual(rules(js("fetch('/pagefind/pagefind.js'); new Worker(u)")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
