#!/usr/bin/env node
// accept/fixtures/report/generate.mjs — RPT-1's metadata events and their ground truth.
//
//   node accept/fixtures/report/generate.mjs              rewrite events/ and truth/ here
//   node accept/fixtures/report/generate.mjs --out DIR    write them under DIR instead (RPT-1
//                                                         checks the committed files are reproducible)
//
// Deterministic (seeded). The events have the exact shape the Gate's sink emits (gate-core
// metadataEvent). Ground truth comes from the hand-written tables below — each route carries its
// kind and pressure, each agent its display name, each day window its UTC bounds written out by
// hand (DST included) — never from the report code. Some events are deliberately dirty, as an
// old or broken Gate might send them (raw paths, query strings, raw IPs, cookies, unknown
// fields): the report may count them, but must never show what they carry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.argv.indexOf("--out");
const DIR = OUT >= 0 ? path.resolve(process.argv[OUT + 1]) : path.dirname(fileURLToPath(import.meta.url));

// Independent copies of the definitions in README.md (not imported from the product).
const CLASSES = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED"];
const KINDS = ["checkout", "login", "signup", "account", "form", "search", "api", "asset", "browse", "malformed"];
const CRITICAL_KINDS = new Set(["checkout", "login", "signup", "account"]);
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOP_AGENTS = 5, TOP_ROUTES = 8;

const SITE = "site-7f3a9c2e", OTHER_SITE = "site-b41d07aa";
const H = 3600_000;
const utc = (s) => Date.parse(s);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(0x5eed_2026);
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (xs) => xs[Math.floor(r() * xs.length)];
function weighted(xs) {
  const total = xs.reduce((n, x) => n + x.w, 0);
  let t = r() * total;
  for (const x of xs) { if ((t -= x.w) < 0) return x; }
  return xs[xs.length - 1];
}
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const token = (n) => Array.from({ length: n }, () => B64U[Math.floor(r() * 64)]).join("");

// ── hand-labelled tables ───────────────────────────────────────────────────────────────
// Routes as the Gate sends them (already templated), with the kind a reader assigns by hand
// (README: the deepest kind word wins, then /api/…, static files, else browse) and the pressure
// of the site's policy for that route.
const ROUTES = [
  { route: "/", kind: "browse", p: 0, methods: ["GET"], w: 10 },
  { route: "/products/:id", kind: "browse", p: 0, methods: ["GET"], w: 22 },
  { route: "/collections/:param", kind: "browse", p: 0, methods: ["GET"], w: 8 },
  { route: "/blog/:param", kind: "browse", p: 0, methods: ["GET"], w: 5 },
  { route: "/search", kind: "search", p: 1, methods: ["GET"], w: 9 },
  { route: "/api/v1/products", kind: "api", p: 0, methods: ["GET"], w: 7 },
  { route: "/assets/app.js", kind: "asset", p: 0, methods: ["GET"], w: 4 },
  { route: "/contact", kind: "form", p: 0, methods: ["GET", "GET", "POST"], w: 3 },
  { route: "/products/:id/reviews", kind: "form", p: 0, methods: ["GET", "POST"], w: 3 },
  { route: "/signup", kind: "signup", p: 1, methods: ["GET", "POST"], w: 2 },
  { route: "/login", kind: "login", p: 2, methods: ["GET", "POST", "POST"], w: 6 },
  { route: "/account/settings", kind: "account", p: 2, methods: ["GET"], w: 2 },
  { route: "/cart", kind: "checkout", p: 2, methods: ["GET", "POST"], w: 5 },
  { route: "/api/v1/cart", kind: "checkout", p: 2, methods: ["GET", "POST", "POST"], w: 3 },
  { route: "/checkout", kind: "checkout", p: 2, methods: ["GET", "POST"], w: 4 },
  { route: "/checkout/:id", kind: "checkout", p: 2, methods: ["GET", "POST"], w: 3 },
];

// Verified agents: the identifier as the event carries it → the name a report may show.
const AGENTS = [
  { diver: "dvr-k7q2m6x4pcab3cde", show: "dvr-k7q2m6x4pcab3cde", w: 5 },
  { diver: "https://shopper.agents.example", show: "shopper.agents.example", w: 4 },
  { diver: "https://crawler.bluefin.example/.well-known/http-message-signatures-directory", show: "crawler.bluefin.example", w: 3 },
  { diver: "https://assist.kumo.example/card", show: "assist.kumo.example", w: 2 },
  { diver: "https://assist.kumo.example", show: "assist.kumo.example", w: 1 },
  { diver: "dvr-m3n8p2q5r7s9t4vw", show: "dvr-m3n8p2q5r7s9t4vw", w: 1 },
  { diver: "https://tiny.agent.example", show: "tiny.agent.example", w: 1 },
];
const CLASS_W = [
  { c: "DECLARED", w: 34 }, { c: "SUSPECTED", w: 29 }, { c: "VERIFIED", w: 16 },
  { c: "UNVERIFIED", w: 8 }, { c: "SPOOFED", w: 10 }, { c: "REVOKED", w: 3 },
];
const COUNTRIES = ["US", "US", "JP", "JP", "DE", "SG", "GB", null];

// The Gate's decision for a class at a pressure (spec §11.3), as the events record it.
function gateDecision(cls, p) {
  if (p <= 0) return { decision: "allow", error: null };
  if (p === 1) return cls === "VERIFIED" ? { decision: "allow", error: null } : { decision: "friction", error: null };
  if (cls === "VERIFIED") return r() < 0.1 ? { decision: "deny", error: "depth_insufficient" } : { decision: "allow", error: null };
  if (cls === "REVOKED") return { decision: "deny", error: "revoked" };
  if (cls === "SPOOFED") return { decision: "deny", error: "invalid_signature" };
  return { decision: "deny", error: "signature_required" };
}

const canaries = { ip: new Set(), rid: new Set(), ip_h: new Set(), value: new Set(), host: new Set() };

/** One event; `o` overrides the random choices. Returns [event, label]. */
function makeEvent(site, ts, o = {}) {
  const cls = o.class ?? weighted(CLASS_W).c;
  const rt = o.routeRow ?? weighted(ROUTES);
  const method = o.method ?? pick(rt.methods);
  const p = o.pressure ?? rt.p;
  const { decision, error } = o.decision ? { decision: o.decision, error: o.error ?? null } : gateDecision(cls, p);
  let diver = null, agent = null;
  if (cls === "VERIFIED") {
    const a = o.agent ?? weighted(AGENTS);
    diver = a.diver; agent = a.show;
  } else if (cls === "REVOKED") diver = "dvr-q9w8e7r6t5y4u3i2";
  else if (cls === "SPOOFED" && r() < 0.4) diver = o.victim ?? "https://shopper.agents.example"; // a replayed or claimed identity
  if (o.diver !== undefined) diver = o.diver;
  const rid = `rcp-${token(16)}`, ip_h = token(22);
  canaries.rid.add(rid); canaries.ip_h.add(ip_h);
  const ev = {
    v: 0, rid, site, ts: Math.floor(ts / 1000), method, route: o.rawRoute ?? rt.route, class: cls, decision, error,
    pressure: p, diver, country: o.country !== undefined ? o.country : pick(COUNTRIES), ip_h, ...(o.extra ?? {}),
  };
  const shownRoute = o.shownRoute ?? rt.route, kind = o.kind ?? rt.kind;
  return [ev, { site, ts: ev.ts * 1000, cls, kind, method, decision, p, agent, route: shownRoute }];
}

// ── the event stream ──────────────────────────────────────────────────────────────────────
const items = [];
const span = (from, to, n, site) => { for (let i = 0; i < n; i++) items.push(makeEvent(site, int(utc(from), utc(to) - 1), {})); };
span("2026-09-27T12:00:00Z", "2026-09-30T12:00:00Z", 1000, SITE);
span("2026-10-30T00:00:00Z", "2026-11-02T12:00:00Z", 900, SITE);
span("2026-09-27T12:00:00Z", "2026-09-30T12:00:00Z", 90, OTHER_SITE);
// Another site's own verified agent: must never show in this site's report.
for (let i = 0; i < 25; i++) items.push(makeEvent(OTHER_SITE, int(utc("2026-09-29T01:00:00Z"), utc("2026-09-29T13:00:00Z")),
  { class: "VERIFIED", agent: { diver: "https://other-only.agent.example", show: "other-only.agent.example" } }));
canaries.host.add("other-only.agent.example");

// Inside both case A (JST 09-29) and case B (UTC 09-29), and inside case C (NY 11-01):
const inAB = () => int(utc("2026-09-29T01:00:00Z"), utc("2026-09-29T14:00:00Z"));
const inC = () => int(utc("2026-11-01T06:00:00Z"), utc("2026-11-02T03:00:00Z"));
const at = (when) => (when === "C" ? inC() : inAB());
const unverifiedCls = () => pick(["DECLARED", "SUSPECTED", "UNVERIFIED", "SPOOFED"]);

for (const when of ["AB", "C"]) {
  // Dirty routes: raw paths and query strings an old Gate might have sent. Shown only templated.
  for (let i = 0; i < 60; i++) items.push(makeEvent(SITE, at(when), { class: unverifiedCls(), method: "POST", pressure: 0,
    rawRoute: "/checkout/4829-1733-canary?coupon=CANARYCOUPON", shownRoute: "/checkout/:token", kind: "checkout", decision: "allow" }));
  for (let i = 0; i < 55; i++) items.push(makeEvent(SITE, at(when), { class: unverifiedCls(), method: "POST", pressure: 0,
    rawRoute: "/203.0.113.77/login", shownRoute: "/:param/login", kind: "login", decision: "allow" }));
  for (let i = 0; i < 50; i++) items.push(makeEvent(SITE, at(when), { class: unverifiedCls(), method: "POST", pressure: 0,
    rawRoute: "/users/zelda-canary/settings?next=CANARYNEXT", shownRoute: "/users/:param/settings", kind: "account", decision: "allow" }));
  // A verified agent whose identifier carries a query token: shown by host only.
  for (let i = 0; i < 50; i++) items.push(makeEvent(SITE, at(when), { class: "VERIFIED",
    agent: { diver: "https://leaky.agent.example/card?token=CANARYAGENTTOKEN", show: "leaky.agent.example" } }));
  // A verified identifier on a raw IP: never shown (it is an address, not a name).
  for (let i = 0; i < 12; i++) items.push(makeEvent(SITE, at(when), { class: "VERIFIED",
    agent: { diver: "https://198.51.100.9/card", show: "(unnamed)" } }));
  // Spoofed claims of another identity, some carrying a session value.
  for (let i = 0; i < 20; i++) items.push(makeEvent(SITE, at(when), { class: "SPOOFED", victim: "https://victim.example/card?sid=CANARYVICTIM" }));
  // Would-be-sensitive fields a broken Gate might add, and bad country values.
  for (let i = 0; i < 30; i++) items.push(makeEvent(SITE, at(when), { country: pick(["Tokyo CANARYCITY", "198.51.100.23"]),
    extra: { ip: "198.51.100.23", xff: "2001:db8::77, 203.0.113.9", cookie: "sid=CANARYCOOKIE", query: "q=CANARYQUERY", ua: "Mozilla/5.0 CANARYUA", body: "card=CANARYBODY" } }));
}
for (const v of ["4829-1733-canary", "CANARYCOUPON", "zelda-canary", "CANARYNEXT", "CANARYAGENTTOKEN", "CANARYVICTIM", "victim.example",
  "CANARYCITY", "CANARYCOOKIE", "CANARYQUERY", "CANARYUA", "CANARYBODY"]) canaries.value.add(v);
for (const v of ["203.0.113.77", "198.51.100.9", "198.51.100.23", "2001:db8::77", "203.0.113.9"]) canaries.ip.add(v);

// Day boundaries, exactly on and one second off (case A: JST 09-29 = [09-28T15:00Z, 09-29T15:00Z)).
for (const t of ["2026-09-28T15:00:00Z", "2026-09-29T14:59:59Z", "2026-09-29T15:00:00Z", "2026-09-28T14:59:59Z"]) items.push(makeEvent(SITE, utc(t), {}));
// DST (case C: New York 11-01 has 25 hours = [11-01T04:00Z, 11-02T05:00Z)). A fixed −4h would lose these.
for (const t of ["2026-11-02T04:00:00Z", "2026-11-02T04:30:00Z", "2026-11-02T04:59:59Z", "2026-11-02T05:00:00Z", "2026-11-01T04:00:00Z", "2026-11-01T03:59:59Z"]) {
  for (let i = 0; i < 3; i++) items.push(makeEvent(SITE, utc(t), {}));
}

items.sort((a, b) => a[0].ts - b[0].ts);

// Lines that are not automation events: counted as skipped, never as traffic.
const junk = [
  "not json at all",
  '{"v":0,"rid":"rcp-truncated","site":"site-7f3a9c2e","ts":17',
  '{"v":0,"site":"site-7f3a9c2e","ts":"yesterday","class":"DECLARED","method":"GET","route":"/","decision":"allow","pressure":0}',
  "[1,2,3]",
  '{"v":0,"site":"site-7f3a9c2e","ts":1790640000,"class":"HUMAN","method":"GET","route":"/","decision":"allow","pressure":0}',
  '{"v":0,"site":"site-7f3a9c2e","ts":1790640000,"class":"UNKNOWN","method":"GET","route":"/","decision":"allow","pressure":0}',
  "null",
];
const lines = items.map(([ev]) => JSON.stringify(ev));
for (const j of junk) lines.splice(int(0, lines.length), 0, j);
lines.splice(int(0, lines.length), 0, ""); // a blank line is ignored, not skipped

// ── ground truth ─────────────────────────────────────────────────────────────────────────
const CASES = [
  { id: "a-jst", date: "2026-09-29", tz: "Asia/Tokyo", win: ["2026-09-28T15:00:00Z", "2026-09-29T15:00:00Z"], prev: ["2026-09-27T15:00:00Z", "2026-09-28T15:00:00Z"] },
  { id: "b-utc", date: "2026-09-29", tz: "UTC", win: ["2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z"], prev: ["2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z"] },
  { id: "c-nyc-dst", date: "2026-11-01", tz: "America/New_York", win: ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"], prev: ["2026-10-31T04:00:00Z", "2026-11-01T04:00:00Z"] },
  { id: "d-no-previous", date: "2026-10-30", tz: "UTC", win: ["2026-10-30T00:00:00Z", "2026-10-31T00:00:00Z"], prev: ["2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z"] },
];

function count(labels) {
  const classes = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const decisions = { allow: 0, friction: 0, deny: 0 };
  const kinds = {}, agents = {}, routes = {};
  const critical = { unverified: 0, allowed: 0, friction: 0, denied: 0 };
  const p1 = { friction: 0, exempt: 0, applies: false };
  for (const l of labels) {
    classes[l.cls]++; decisions[l.decision]++;
    const k = (kinds[l.kind] ??= { automation: 0, verified: 0, denied: 0 });
    k.automation++; if (l.cls === "VERIFIED") k.verified++; if (l.decision === "deny") k.denied++;
    if (l.cls === "VERIFIED") agents[l.agent] = (agents[l.agent] ?? 0) + 1;
    if (l.cls !== "VERIFIED" && (CRITICAL_KINDS.has(l.kind) || WRITES.has(l.method))) {
      critical.unverified++;
      critical[{ allow: "allowed", friction: "friction", deny: "denied" }[l.decision]]++;
      routes[l.route] = (routes[l.route] ?? 0) + 1;
    }
    if (l.p === 0) { p1.applies = true; if (l.cls === "VERIFIED") p1.exempt++; else p1.friction++; }
  }
  const byCount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  return {
    events: labels.length, classes, decisions,
    verified_actions: classes.VERIFIED,
    verified_agents: Object.keys(agents).filter((a) => a !== "(unnamed)").length,
    critical,
    kinds: Object.fromEntries(KINDS.filter((k) => kinds[k]).map((k) => [k, kinds[k]])),
    top_agents: Object.entries(agents).sort(byCount).slice(0, TOP_AGENTS).map(([agent, actions]) => ({ agent, actions })),
    top_critical_routes: Object.entries(routes).sort(byCount).slice(0, TOP_ROUTES).map(([route, count]) => ({ route, count })),
    pressure1: p1,
  };
}

const labels = items.map(([, l]) => l);
const within = (l, [a, b]) => l.site === SITE && l.ts >= utc(a) && l.ts < utc(b);

fs.mkdirSync(path.join(DIR, "events"), { recursive: true });
fs.mkdirSync(path.join(DIR, "truth"), { recursive: true });
fs.writeFileSync(path.join(DIR, "events", "gate-events.ndjson"), lines.join("\n") + "\n");

for (const c of CASES) {
  const cur = count(labels.filter((l) => within(l, c.win)));
  const prevLabels = labels.filter((l) => within(l, c.prev));
  const prev = prevLabels.length ? count(prevLabels) : null;
  const pv = prev && { events: prev.events, verified_actions: prev.verified_actions, critical_unverified: prev.critical.unverified, spoofed: prev.classes.SPOOFED };
  const cv = { events: cur.events, verified_actions: cur.verified_actions, critical_unverified: cur.critical.unverified, spoofed: cur.classes.SPOOFED };
  const truth = {
    case: c.id, events_file: "events/gate-events.ndjson", site: SITE, date: c.date, tz: c.tz,
    window: { start: new Date(utc(c.win[0])).toISOString(), end: new Date(utc(c.win[1])).toISOString() },
    expect: {
      ...cur,
      previous: pv,
      delta: pv && Object.fromEntries(Object.keys(cv).map((k) => [k, cv[k] - pv[k]])),
      skipped: junk.length,
    },
    canaries: "truth/canaries.json",
  };
  fs.writeFileSync(path.join(DIR, "truth", `${c.id}.truth.json`), JSON.stringify(truth, null, 1) + "\n");
}
// What no rendering may ever contain: planted values, raw IPs, every receipt id and IP hash.
fs.writeFileSync(path.join(DIR, "truth", "canaries.json"), JSON.stringify({
  ip: [...canaries.ip], value: [...canaries.value], host: [...canaries.host],
  rid: [...canaries.rid].sort(), ip_h: [...canaries.ip_h].sort(),
}) + "\n");
