// PRIV-4 (−): only hourly counts leave the Gate (ADR-038, spec §12.9, §23.4). The key of a count
// is the route template, the method, the class, the decision and the operator; the value is the
// count. No visit's time, IP hash or country leaves; per-visit records stay on the site 7 days.
// Whether a visit is "user-initiated" is not judged: every visit is treated the same.
//
// The real gate-node middleware and the real HTTP sink (the one report.endpoint builds) post to a
// local collector, over three hours of a clock the test moves. Every byte the collector receives
// is judged; the judge is tried on planted deliveries first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ludionGate } from "../index.mjs";
import { generateSiteKey, BATCH_KIND, ROW_KEYS, HOUR_S, RECORD_DAYS, metadataEvent } from "@ludion/gate-core";
import { httpSink } from "@ludion/gate-core/config";

const SITE = "site-priv4";
const BATCH_KEYS = ["v", "kind", "site", "hour", "rows"];
const V4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;
const V6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;

/** What is wrong with what the collector received (raw bodies). */
export function deliveryProblems(bodies, { canaries = [], times = [] } = {}) {
  const out = [];
  for (const raw of bodies) {
    let b;
    try { b = JSON.parse(raw); } catch { out.push(`not JSON: ${raw.slice(0, 60)}`); continue; }
    const keys = Object.keys(b ?? {}).sort();
    if (keys.join() !== [...BATCH_KEYS].sort().join()) out.push(`a delivery with keys ${keys.join(",")}: not an hourly batch`);
    if (b?.kind !== BATCH_KIND) out.push(`kind ${JSON.stringify(b?.kind)}`);
    if (!Number.isInteger(b?.hour) || b.hour % HOUR_S !== 0) out.push(`hour ${b?.hour} is not the start of an hour`);
    for (const row of Array.isArray(b?.rows) ? b.rows : []) {
      const rk = Object.keys(row ?? {}).sort();
      if (rk.join() !== [...ROW_KEYS].sort().join()) out.push(`a row with keys ${rk.join(",")}`);
      if (!Number.isInteger(row?.count) || row.count < 1) out.push(`count ${row?.count}`);
    }
    if (V4.test(raw) || V6.test(raw)) out.push("an IP address");
    for (const c of canaries) if (raw.includes(c)) out.push(`canary ${c}`);
    for (const t of times) if (raw.includes(String(t))) out.push(`a visit's time ${t}`);
  }
  return out;
}

async function collector() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let s = "";
    req.on("data", (d) => { s += d; });
    req.on("end", () => { bodies.push(s); res.writeHead(204).end(); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { bodies, url: `http://127.0.0.1:${srv.address().port}/events`, close: () => new Promise((r) => srv.close(() => r())) };
}

function incoming({ method = "GET", url, ua, ip, country, cookie }) {
  const headers = { host: "shop.example", "user-agent": ua, "x-forwarded-for": ip, "cf-ipcountry": country, cookie };
  const raw = [];
  for (const [k, v] of Object.entries(headers)) if (v != null) raw.push(k, v);
  return { method, url, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null)), rawHeaders: raw, socket: { remoteAddress: "10.0.0.1", encrypted: false } };
}
function outgoing() { const res = { statusCode: 200, headers: {} }; res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; }; res.end = () => {}; return res; }
const settle = () => new Promise((r) => setTimeout(r, 50));

const col = await collector();
after(() => col.close());

test("PRIV-4: the judge catches a delivery that is not an hourly count (planted)", () => {
  const good = JSON.stringify({ v: 0, kind: BATCH_KIND, site: SITE, hour: 1790000000 - (1790000000 % HOUR_S), rows: [{ route: "/products/:id", method: "GET", class: "SUSPECTED", decision: "allow", operator: "none", count: 3 }] });
  assert.deepEqual(deliveryProblems([good]), [], "control");
  const receipt = { rid: "rcp-x", site: SITE, ts: 1790000123, method: "GET", route: "/p/:id", class: "SUSPECTED", decision: "allow", error: null, pressure: 0, diver: null };
  const planted = [
    ["a per-visit event (the old sink)", JSON.stringify(metadataEvent({ receipt, path: "/p/1", ip: "203.0.113.9", ipSalt: "s", country: "JP" })), /not an hourly batch/],
    ["a batch with the visit's time", JSON.stringify({ ...JSON.parse(good), ts: 1790000123 }), /not an hourly batch/],
    ["a row with an IP hash", good.replace('"count":3', '"count":3,"ip_h":"abc"'), /a row with keys/],
    ["a row with a country", good.replace('"count":3', '"count":3,"country":"JP"'), /a row with keys/],
    ["an hour that is not an hour", good.replace(/"hour":\d+/, '"hour":1790000123'), /not the start of an hour/],
    ["a raw IP anywhere", good.replace("/products/:id", "/products/203.0.113.9"), /an IP address/],
    ["a canary", good.replace("/products/:id", "/products/ludioncanaryq"), /canary ludioncanaryq/],
  ];
  for (const [what, body, why] of planted) assert.ok(deliveryProblems([body], { canaries: ["ludioncanaryq"] }).some((p) => why.test(p)), what);
});

test("PRIV-4: over three hours, only one batch per hour leaves; the counts are the visits; no time, IP, country or canary; records stay 7 days", async () => {
  const start = Date.UTC(2026, 9, 3, 10, 20, 7);
  let now = start;
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({
    siteId: SITE, siteKey: siteKey.privateJwk, pressure: 0, now: () => now, trustProxy: true,
    routes: [{ match: "/checkout/**", pressure: 2 }],
    sink: httpSink(col.url),
  });
  const run = (o) => new Promise((resolve) => { const req = incoming(o), res = outgoing(); Promise.resolve(mw(req, res, resolve)).then(resolve); }).then(() => undefined);
  const canaries = [], times = [];
  const perHour = [0, 0, 0];
  let automation = 0, humans = 0;
  for (let h = 0; h < 3; h++) {
    for (let i = 0; i < 40; i++) {
      now = start + h * HOUR_S * 1000 + i * 37_000;
      times.push(Math.floor(now / 1000));
      const c = `ludioncanary${String.fromCharCode(97 + h)}${String.fromCharCode(97 + (i % 26))}`;
      canaries.push(c);
      const ip = `198.51.${h}.${i + 1}`;
      const kind = i % 4;
      if (kind === 3) { humans++; await run({ url: `/products/${i}?q=${c}`, ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", ip, country: "JP", cookie: `s=${c}` }); continue; }
      const ua = kind === 0 ? "curl/8.7.1" : kind === 1 ? "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot" : "python-requests/2.32.3";
      await run({ method: kind === 2 ? "POST" : "GET", url: kind === 2 ? `/checkout/${i}?coupon=${c}` : `/products/${i}?q=${c}`, ua, ip, country: "DE", cookie: `s=${c}` });
      automation++; perHour[h]++;
    }
    // The hour has not closed: nothing of it has left.
    await settle();
    assert.equal(col.bodies.length, h, `after hour ${h + 1}'s visits, ${col.bodies.length} deliveries (expected ${h}: one per closed hour)`);
  }
  mw.gate.flush({ all: true });
  await settle();
  assert.equal(col.bodies.length, 3, "one delivery per hour, never one per visit");
  assert.deepEqual(deliveryProblems(col.bodies, { canaries, times: times.filter((t) => t % HOUR_S !== 0) }), []);
  const batches = col.bodies.map((b) => JSON.parse(b));
  assert.deepEqual(batches.map((b) => b.rows.reduce((n, r) => n + r.count, 0)), perHour, "each hour's counts are its automated visits");
  assert.ok(batches.every((b) => b.site === SITE));
  const ops = new Set(batches.flatMap((b) => b.rows.map((r) => r.operator)));
  assert.ok(ops.has("GPTBot") && ops.has("none"), `operators: ${[...ops].join(", ")}`);
  assert.ok(batches.flatMap((b) => b.rows).every((r) => r.route === "/products/:id" || r.route === "/checkout/:id"), "routes are templates");
  console.log(`PRIV-4: ${automation} automated visits over 3 hours left as ${col.bodies.length} hourly batches (${batches.reduce((n, b) => n + b.rows.length, 0)} rows); ${humans} human visits counted nowhere; 0 times, IPs, countries or canaries`);

  // On the site: the visits' records, for 7 days.
  assert.equal(mw.gate.records.list().length, automation, "every automated visit is recorded on the site");
  now = start + RECORD_DAYS * 86_400_000 + 3 * HOUR_S * 1000;
  await run({ url: "/products/9", ua: "curl/8.7.1", ip: "198.51.100.9" });
  assert.equal(mw.gate.records.list().length, 1, "after 7 days the old records are gone");
});
