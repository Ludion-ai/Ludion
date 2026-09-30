// Counting. One record in, counters out. Classification reuses the Gate's own rules for
// unsigned traffic (spec §11.5): a published agent token → DECLARED, an automation signal or no
// User-Agent → SUSPECTED, everything else (humans included) → UNKNOWN. A request that carried a
// Web Bot Auth signature is UNVERIFIED: a log holds neither the covered components nor the key,
// so nobody verified it (draft App. C.1). A log can never produce VERIFIED; only a Gate can.
//
// Nothing that identifies a person is kept: no IPs, no query values, and routes only as strict
// templates (publicTemplateSegment: identifiers → :id/:uuid/…, any word that is not a known
// route word → :param).
import { matchKnownAgent, matchAutomationSignal } from "@ludion/gate-core/agents";
import { routeKind, isCritical, pathOf, publicTemplateSegment, ROUTE_KINDS, CRITICAL_KINDS, WRITE_METHODS } from "@ludion/gate-core/route";

export const SCAN_CLASSES = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED", "UNKNOWN"];
const AUTOMATION = new Set(["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED"]);
const MAX_DEPTH = 6;

export const CRITICAL_DEFINITION =
  `kind ∈ {${[...CRITICAL_KINDS].join(", ")}}, or method ∈ {${[...WRITE_METHODS].join(", ")}} on any route`;

const zeroClasses = () => Object.fromEntries(SCAN_CLASSES.map((c) => [c, 0]));
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

/** @returns {{ class: string, operator?: string, signal?: string, noUaField?: boolean }} */
export function classifyRecord(rec) {
  if (rec.signed) return { class: "UNVERIFIED" };
  if (rec.ua === undefined) return { class: "UNKNOWN", noUaField: true };
  const known = matchKnownAgent(rec.ua || undefined);
  if (known) return { class: "DECLARED", operator: known.operator };
  const signal = matchAutomationSignal(rec.ua || undefined);
  if (signal) return { class: "SUSPECTED", signal };
  return { class: "UNKNOWN" };
}

/** Route template for display: strict segments, at most MAX_DEPTH deep (the rest is `**`). */
export function displayRoute(target) {
  const p = pathOf(target);
  if (p == null) return null;
  const segs = p.split("/").slice(1);
  const out = segs.slice(0, MAX_DEPTH).map(publicTemplateSegment);
  if (segs.length > MAX_DEPTH) out[MAX_DEPTH - 1] = "**";
  return `/${out.join("/")}`;
}

export function createAggregator() {
  const s = {
    records: 0, parsed: 0, classes: zeroClasses(), operators: {}, signals: {}, noUaField: 0,
    kinds: Object.fromEntries(ROUTE_KINDS.map((k) => [k, { ...zeroClasses(), writes: 0 }])),
    critical: { unverified_automation: 0, served: 0, by_kind: {} }, first: null, last: null,
  };
  const routes = new Map();
  const uaCache = new Map(), routeCache = new Map();

  function classify(rec) {
    if (rec.signed || rec.ua === undefined) return classifyRecord(rec);
    let c = uaCache.get(rec.ua);
    if (!c) { if (uaCache.size > 50_000) uaCache.clear(); c = classifyRecord(rec); uaCache.set(rec.ua, c); }
    return c;
  }

  function route(rec) {
    let r = routeCache.get(rec.target);
    if (r === undefined) { if (routeCache.size > 50_000) routeCache.clear(); r = displayRoute(rec.target); routeCache.set(rec.target, r); }
    return r;
  }

  return {
    /** @param {object|false} rec a parsed record, or false for a record that did not parse */
    add(rec) {
      s.records++;
      if (!rec) return;
      s.parsed++;
      if (rec.ts != null) { if (s.first == null || rec.ts < s.first) s.first = rec.ts; if (s.last == null || rec.ts > s.last) s.last = rec.ts; }
      const c = classify(rec);
      s.classes[c.class]++;
      if (c.noUaField) s.noUaField++;
      if (c.operator) bump(s.operators, c.operator);
      if (c.signal) bump(s.signals, c.signal);
      const method = String(rec.method ?? "").toUpperCase();
      const kind = rec.method == null ? "malformed" : routeKind(method, rec.target);
      const write = WRITE_METHODS.has(method);
      s.kinds[kind][c.class]++;
      if (write) s.kinds[kind].writes++;
      if (!AUTOMATION.has(c.class)) return;
      const critical = kind !== "malformed" && c.class !== "VERIFIED" && isCritical(method, kind);
      if (critical) {
        s.critical.unverified_automation++;
        bump(s.critical.by_kind, kind);
        if (rec.status != null && rec.status > 0 && rec.status < 400) s.critical.served++;
      }
      const r = kind === "malformed" ? null : route(rec);
      if (r == null) return;
      let e = routes.get(r);
      if (!e) routes.set(r, (e = { route: r, automation: 0, critical: 0, writes: 0, classes: {}, kinds: {} }));
      e.automation++; bump(e.classes, c.class); bump(e.kinds, kind);
      if (critical) e.critical++;
      if (write) e.writes++;
    },
    /** @param {{ top?: number }} [opts] */
    finish(opts = {}) {
      const automation = [...AUTOMATION].reduce((n, c) => n + s.classes[c], 0);
      const top = [...routes.values()]
        .sort((a, b) => b.critical - a.critical || b.automation - a.automation || (a.route < b.route ? -1 : 1))
        .slice(0, opts.top ?? 15)
        .map(({ kinds, ...e }) => ({ ...e, kind: Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0] }));
      return {
        records: s.records, parsed: s.parsed,
        window: { first: s.first == null ? null : new Date(s.first).toISOString(), last: s.last == null ? null : new Date(s.last).toISOString() },
        classes: { ...s.classes }, automation, operators: sortObj(s.operators), signals: sortObj(s.signals),
        no_user_agent_field: s.noUaField, kinds: s.kinds,
        critical: { definition: CRITICAL_DEFINITION, unverified_automation: s.critical.unverified_automation, served: s.critical.served, by_kind: sortObj(s.critical.by_kind) },
        routes: top,
      };
    },
  };
}

function sortObj(o) { return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))); }
