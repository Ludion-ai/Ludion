// From metadata events to the numbers of the daily report (spec §11.8).
//
// Input is what the Gate's sink emits (gate-core metadataEvent, spec §11.7). Only a fixed set of
// fields is ever read — site, ts, method, route, class, decision, pressure, diver — and nothing
// else is carried forward, so a field an old or broken Gate added (a raw IP, a cookie, a query)
// cannot reach the report. Routes are shown only as strict templates, agents only by a name
// that is not an address.
import { decide, AUTOMATION } from "@ludion/gate-core";
import { routeKind, isCritical, pathOf, publicTemplateSegment, ROUTE_KINDS } from "@ludion/gate-core/route";
import { dayWindow, addDays } from "./window.mjs";

export const REPORT_CLASSES = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED"];
export const TOP_AGENTS = 5, TOP_ROUTES = 8;
export const UNNAMED = "(unnamed)";
const DECISIONS = new Set(["allow", "friction", "deny"]);
const PLACEHOLDER = /^:(?:id|uuid|email|handle|hex|token|param)$/;
const DIVER_ID = /^dvr-[a-z0-9]{8,40}$/;

/** One parsed event with only the fields the report may use, or null when it is not one. */
export function readEvent(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  if (typeof e.site !== "string" || typeof e.ts !== "number" || !Number.isFinite(e.ts)) return null;
  if (!AUTOMATION.has(e.class) || !DECISIONS.has(e.decision)) return null;
  if (!Number.isInteger(e.pressure) || e.pressure < 0 || e.pressure > 3) return null;
  return {
    site: e.site, ts: e.ts * 1000,
    method: typeof e.method === "string" ? e.method.toUpperCase() : "OTHER",
    route: typeof e.route === "string" ? e.route : "",
    class: e.class, decision: e.decision, pressure: e.pressure,
    diver: typeof e.diver === "string" ? e.diver : null,
  };
}

const HOURLY = "ludion.hourly";

/**
 * An hourly batch (what a Gate sends out, ADR-038) as weighted events: one per row, `n` its count,
 * at the hour's start, with no pressure (a batch does not carry it). Null when it is not a batch.
 */
export function readBatch(b) {
  if (!b || typeof b !== "object" || b.kind !== HOURLY) return null;
  if (typeof b.site !== "string" || !Number.isInteger(b.hour) || b.hour % 3600 !== 0 || !Array.isArray(b.rows)) return null;
  const out = [];
  for (const r of b.rows) {
    if (!r || !AUTOMATION.has(r.class) || !DECISIONS.has(r.decision) || !Number.isInteger(r.count) || r.count < 1) return null;
    out.push({
      site: b.site, ts: b.hour * 1000,
      method: typeof r.method === "string" ? r.method.toUpperCase() : "OTHER",
      route: typeof r.route === "string" ? r.route : "",
      class: r.class, decision: r.decision, pressure: null,
      diver: typeof r.operator === "string" && r.operator !== "none" ? r.operator : null,
      n: r.count,
    });
  }
  return out;
}

/**
 * NDJSON (one event per line; a JSON array is accepted too): the site's per-visit records, or the
 * hourly batches a Gate sends out (one line per batch). Blank lines are ignored; every other line
 * that is neither is counted as skipped, never as traffic.
 * @returns {{ events: object[], skipped: number }}
 */
export function parseEvents(text) {
  const events = [];
  let skipped = 0;
  const take = (e) => {
    const rows = readBatch(e);
    if (rows) { events.push(...rows); return; }
    const ev = readEvent(e);
    if (ev) events.push(ev); else skipped++;
  };
  const t = text.replace(/^﻿/, "");
  if (/^\s*\[/.test(t)) {
    let arr;
    try { arr = JSON.parse(t); } catch { arr = null; }
    if (Array.isArray(arr)) {
      for (const e of arr) take(e);
      return { events, skipped };
    }
  }
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { skipped++; continue; }
    take(e);
  }
  return { events, skipped };
}

/** A route as the report shows it: template placeholders kept, every other segment strict. */
export function displayRoute(route) {
  const p = pathOf(route);
  if (p == null || p === "") return null;
  return p.split("/").map((s) => (PLACEHOLDER.test(s) ? s : publicTemplateSegment(s))).join("/");
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A verified agent's name: its Diver id, or the host of its identifier URL — never an address. */
export function agentName(diver) {
  if (typeof diver !== "string") return UNNAMED;
  if (DIVER_ID.test(diver)) return diver;
  // An hourly count names a non-Ludion signer by the bare host of its identifier (ADR-038).
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(diver) && !IPV4.test(diver)) return diver.toLowerCase();
  let u;
  try { u = new URL(diver); } catch { return UNNAMED; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return UNNAMED;
  const h = u.hostname.toLowerCase();
  if (!h || h.includes(":") || h.startsWith("[") || IPV4.test(h) || !/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return UNNAMED;
  return h;
}

const byCount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);

/** The numbers for one site and one window. */
export function count(events) {
  const classes = Object.fromEntries(REPORT_CLASSES.map((c) => [c, 0]));
  const decisions = { allow: 0, friction: 0, deny: 0 };
  const kinds = {}, agents = new Map(), routes = new Map();
  const critical = { unverified: 0, allowed: 0, friction: 0, denied: 0 };
  const pressure1 = { friction: 0, exempt: 0, applies: false };
  let total = 0, pressureKnown = false;
  for (const e of events) {
    const n = e.n ?? 1; // an hourly row stands for n visits; a per-visit record for one
    total += n;
    classes[e.class] += n;
    decisions[e.decision] += n;
    const kind = routeKind(e.method, e.route);
    const k = (kinds[kind] ??= { automation: 0, verified: 0, denied: 0 });
    k.automation += n;
    if (e.class === "VERIFIED") { k.verified += n; const a = agentName(e.diver); agents.set(a, (agents.get(a) ?? 0) + n); }
    if (e.decision === "deny") k.denied += n;
    if (e.class !== "VERIFIED" && kind !== "malformed" && isCritical(e.method, kind)) {
      critical.unverified += n;
      critical[{ allow: "allowed", friction: "friction", deny: "denied" }[e.decision]] += n;
      const r = displayRoute(e.route);
      if (r) routes.set(r, (routes.get(r) ?? 0) + n);
    }
    // What Pressure 1 would do to what is at Pressure 0 today: the Gate's own rule (spec §11.3).
    // Only per-visit records carry the pressure; hourly counts do not (ADR-038).
    if (e.pressure != null) pressureKnown = true;
    if (e.pressure === 0) {
      pressure1.applies = true;
      const d = decide({ class: e.class }, { pressure: 1 });
      if (d.action === "friction") pressure1.friction += n;
      else if (d.exempt) pressure1.exempt += n;
    }
  }
  if (!pressureKnown && events.length) pressure1.unknown = true;
  return {
    events: total, classes, decisions,
    verified_actions: classes.VERIFIED,
    verified_agents: [...agents.keys()].filter((a) => a !== UNNAMED).length,
    critical,
    kinds: Object.fromEntries(ROUTE_KINDS.filter((k) => kinds[k]).map((k) => [k, kinds[k]])),
    top_agents: [...agents].sort(byCount).slice(0, TOP_AGENTS).map(([agent, actions]) => ({ agent, actions })),
    top_critical_routes: [...routes].sort(byCount).slice(0, TOP_ROUTES).map(([route, n]) => ({ route, count: n })),
    pressure1,
  };
}

/** Sites present in the events. */
export const sitesOf = (events) => [...new Set(events.map((e) => e.site))].sort();

/**
 * The daily report's numbers.
 * @param {object[]} events from parseEvents
 * @param {{ site: string, date: string, tz: string, skipped?: number }} opts
 */
export function summarize(events, { site, date, tz, skipped = 0 }) {
  const win = dayWindow(date, tz), prevWin = dayWindow(addDays(date, -1), tz);
  const mine = events.filter((e) => e.site === site);
  const cur = count(mine.filter((e) => e.ts >= win.start && e.ts < win.end));
  const prevEvents = mine.filter((e) => e.ts >= prevWin.start && e.ts < prevWin.end);
  const prev = prevEvents.length ? count(prevEvents) : null;
  const pick = (c) => ({ events: c.events, verified_actions: c.verified_actions, critical_unverified: c.critical.unverified, spoofed: c.classes.SPOOFED });
  const pv = prev && pick(prev), cv = pick(cur);
  return {
    report: "ludion daily report", v: 0, site, date, tz,
    window: { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() },
    ...cur,
    previous: pv,
    delta: pv && Object.fromEntries(Object.keys(cv).map((k) => [k, cv[k] - pv[k]])),
    skipped,
  };
}
