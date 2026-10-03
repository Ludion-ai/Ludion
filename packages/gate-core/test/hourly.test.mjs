// The hourly counts and the site's records (ADR-038; PRIV-4 runs them through gate-node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHourly, operatorOf, memoryRecords, HOUR_S, BATCH_KIND, ROW_KEYS, RECORD_DAYS } from "../src/index.mjs";

const rec = (ts, o = {}) => ({ v: 0, rid: "rcp-x", site: "s", ts, method: "GET", route: "/p/:id", class: "SUSPECTED", decision: "allow", error: null, pressure: 0, diver: null, country: "JP", ip_h: "h", ...o });

test("hourly: the operator is a Diver id, a signer's host, a declared token, or none — never a path or an address", () => {
  assert.equal(operatorOf({ class: "VERIFIED", diverId: "dvr-k7q2m6x4pcab3cde" }), "dvr-k7q2m6x4pcab3cde");
  assert.equal(operatorOf({ class: "VERIFIED", identifier: "https://chatgpt.com/.well-known/http-message-signatures-directory?x=1" }), "chatgpt.com");
  assert.equal(operatorOf({ class: "SPOOFED", identifier: "https://203.0.113.9/x" }), "none");
  assert.equal(operatorOf({ class: "SPOOFED", identifier: "not a url" }), "none");
  assert.equal(operatorOf({ class: "DECLARED", token: "GPTBot", operator: "OpenAI" }), "GPTBot");
  assert.equal(operatorOf({ class: "DECLARED", token: "bad token/../x" }), "none");
  assert.equal(operatorOf({ class: "SUSPECTED", signal: "curl/" }), "none");
  assert.equal(operatorOf(undefined), "none");
});

test("hourly: an hour is sent once it has closed, as counts with the five keys; the current hour waits", () => {
  const h0 = 1790000000 - (1790000000 % HOUR_S);
  let now = (h0 + 100) * 1000;
  const sent = [];
  const hr = createHourly({ siteId: "s", now: () => now, emit: (b) => sent.push(b) });
  hr.add(rec(h0 + 10), "none"); hr.add(rec(h0 + 20), "none"); hr.add(rec(h0 + 30, { class: "DECLARED" }), "GPTBot");
  hr.flushClosed();
  assert.equal(sent.length, 0, "the hour is still open");
  now = (h0 + HOUR_S + 5) * 1000;
  hr.add(rec(h0 + HOUR_S + 1), "none");
  hr.flushClosed();
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["hour", "kind", "rows", "site", "v"]);
  assert.equal(sent[0].kind, BATCH_KIND);
  assert.equal(sent[0].hour, h0);
  for (const r of sent[0].rows) assert.deepEqual(Object.keys(r).sort(), [...ROW_KEYS].sort());
  assert.deepEqual(sent[0].rows.map((r) => [r.class, r.operator, r.count]), [["SUSPECTED", "none", 2], ["DECLARED", "GPTBot", 1]]);
  hr.flushAll();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].hour, h0 + HOUR_S);
  hr.flushAll();
  assert.equal(sent.length, 2, "nothing is sent twice");
});

test("hourly: past the row cap, an hour's extra keys fold into one (other) row; nothing is lost", () => {
  const h0 = 1790000000 - (1790000000 % HOUR_S);
  const sent = [];
  const hr = createHourly({ siteId: "s", now: () => (h0 + 7200) * 1000, emit: (b) => sent.push(b), maxRows: 3 });
  for (let i = 0; i < 10; i++) hr.add(rec(h0 + i, { route: `/r${i}` }), "none");
  hr.flushClosed();
  assert.equal(sent[0].rows.length, 4);
  assert.equal(sent[0].rows.reduce((n, r) => n + r.count, 0), 10);
  assert.ok(sent[0].rows.some((r) => r.route === "(other)" && r.count === 7));
});

test("records: the site keeps each visit for 7 days, then forgets it; a full store drops the oldest", () => {
  let now = 1790000000 * 1000;
  const store = memoryRecords({ now: () => now, max: 3 });
  store.put(rec(1790000000)); store.put(rec(1790000001));
  assert.equal(store.list().length, 2);
  now += RECORD_DAYS * 86_400_000 + 1000;
  store.put(rec(Math.floor(now / 1000)));
  assert.deepEqual(store.list().map((r) => r.ts), [Math.floor(now / 1000)], "older than 7 days: gone");
  for (let i = 1; i <= 4; i++) store.put(rec(Math.floor(now / 1000) + i));
  assert.equal(store.list().length, 3, "capped");
});
