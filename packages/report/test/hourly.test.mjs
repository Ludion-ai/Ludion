// The report from hourly counts (what a Gate sends out, ADR-038) says what it says from the site's
// per-visit records, for whole hours; only the Pressure 1 preview, which needs each visit's
// pressure, is left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHourly } from "@ludion/gate-core";
import { parseEvents, summarize } from "../src/summarize.mjs";
import { renderText } from "../src/render.mjs";

const SITE = "site-hourly";
const DAY0 = Date.UTC(2026, 8, 29) / 1000;
const CLASSES = ["VERIFIED", "SUSPECTED", "DECLARED", "SPOOFED", "UNVERIFIED"];
const ROUTES = [["GET", "/products/:id"], ["POST", "/login"], ["POST", "/checkout/:id"], ["GET", "/"], ["POST", "/contact"]];
const DECISIONS = ["allow", "allow", "friction", "deny"];

function visits() {
  let a = 7;
  const rnd = () => ((a = (a * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const cls = CLASSES[Math.floor(rnd() * CLASSES.length)], [method, route] = ROUTES[Math.floor(rnd() * ROUTES.length)];
    out.push({
      v: 0, rid: `rcp-${i}`, site: SITE, ts: DAY0 - 3 * 3600 + Math.floor(rnd() * 30 * 3600), method, route, class: cls,
      decision: DECISIONS[Math.floor(rnd() * DECISIONS.length)], error: null, pressure: 0,
      diver: cls === "VERIFIED" ? ["dvr-aaaaaaaaaaaaaaaa", "dvr-bbbbbbbbbbbbbbbb", "https://chatgpt.com/.well-known/x"][i % 3] : null,
      country: "JP", ip_h: "x",
    });
  }
  return out.sort((x, y) => x.ts - y.ts);
}

test("report: hourly counts give the per-visit records' numbers for whole hours; the Pressure 1 preview is left out", () => {
  const recs = visits();
  const batches = [];
  const hr = createHourly({ siteId: SITE, now: () => 0, emit: (b) => batches.push(b) });
  for (const r of recs) hr.add(r, r.class === "VERIFIED" ? (r.diver.startsWith("dvr-") ? r.diver : "chatgpt.com") : "none");
  hr.flushAll();
  const fromVisits = parseEvents(recs.map((r) => JSON.stringify(r)).join("\n"));
  const fromHours = parseEvents(batches.map((b) => JSON.stringify(b)).join("\n"));
  assert.equal(fromHours.skipped, 0);
  const opts = { site: SITE, date: "2026-09-29", tz: "UTC" };
  const a = summarize(fromVisits.events, opts), b = summarize(fromHours.events, opts);
  for (const k of ["events", "classes", "decisions", "verified_actions", "verified_agents", "critical", "kinds", "top_agents", "top_critical_routes", "previous", "delta"]) {
    assert.deepEqual(b[k], a[k], k);
  }
  assert.ok(a.events > 1000 && a.previous, "the window and the day before both hold visits");
  assert.equal(a.pressure1.applies, true);
  assert.equal(b.pressure1.unknown, true, "hourly counts carry no pressure");
  assert.doesNotMatch(renderText(b, "en"), /Pressure 1/i, "nothing is said about Pressure 1 from counts alone");
});

test("report: a malformed hourly batch is skipped, never counted", () => {
  const good = { v: 0, kind: "ludion.hourly", site: SITE, hour: DAY0, rows: [{ route: "/", method: "GET", class: "SUSPECTED", decision: "allow", operator: "none", count: 2 }] };
  for (const bad of [{ ...good, hour: DAY0 + 1 }, { ...good, rows: [{ ...good.rows[0], count: 0 }] }, { ...good, rows: [{ ...good.rows[0], class: "HUMAN" }] }, { ...good, site: 7 }]) {
    const r = parseEvents(JSON.stringify(bad));
    assert.equal(r.events.length, 0, JSON.stringify(bad));
    assert.equal(r.skipped, 1);
  }
  assert.equal(parseEvents(JSON.stringify(good)).events.length, 1);
});
