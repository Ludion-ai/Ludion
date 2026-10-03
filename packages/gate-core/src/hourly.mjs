// What leaves the Gate (ADR-038, spec §12.9, PRIV-4): hourly counts, nothing per visit.
//
// The key of a count is the route template, the method, the class, the decision and the operator
// (a Diver id or the name the agent gave, else "none"). A batch carries the site and the hour it
// counts (Unix seconds of the hour's start); no visit's time, IP hash or country is in it. Per-visit
// records stay on the site (records.mjs). Runtime-neutral: no timers here; the Gate flushes the
// hours that have closed whenever it inspects a request, and an adapter may also call flush().

export const HOUR_S = 3600;
export const BATCH_KIND = "ludion.hourly";
/** Distinct keys one hour may hold; past it, counts go to one "(other)" row (no memory blow-up). */
export const MAX_ROWS_PER_HOUR = 5000;
export const ROW_KEYS = ["route", "method", "class", "decision", "operator", "count"];

const DIVER_ID = /^dvr-[a-z0-9]{8,40}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The operator of a classified request: the Diver id, or for a non-Ludion signer the host of the
 * identifier it signed with, or for a declared agent its token (e.g. "GPTBot"); else "none".
 * Never a path, a query, an address.
 */
export function operatorOf(cls) {
  if (typeof cls?.diverId === "string" && DIVER_ID.test(cls.diverId)) return cls.diverId;
  if (typeof cls?.identifier === "string") {
    try {
      const u = new URL(cls.identifier);
      const h = u.hostname.toLowerCase();
      if ((u.protocol === "https:" || u.protocol === "http:") && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return h;
    } catch { /* not a URL */ }
  }
  if (cls?.class === "DECLARED" && typeof cls.token === "string" && TOKEN.test(cls.token)) return cls.token;
  return "none";
}

/**
 * @param {{ siteId: string, now: () => number, emit: (batch: object) => void, maxRows?: number }} o
 */
export function createHourly({ siteId, now, emit, maxRows = MAX_ROWS_PER_HOUR }) {
  /** hour (Unix s) → Map(key → row) */
  const hours = new Map();
  const hourOf = (ms) => Math.floor(ms / 1000 / HOUR_S) * HOUR_S;
  const batch = (hour, rows) => ({
    v: 0, kind: BATCH_KIND, site: siteId, hour,
    rows: [...rows.values()].sort((a, b) => b.count - a.count || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  });
  function send(hour) {
    const rows = hours.get(hour);
    hours.delete(hour);
    if (rows?.size) emit(batch(hour, rows));
  }
  return {
    /** Count one per-visit record (gate-core metadataEvent) under its hour. */
    add(record, operator) {
      const hour = hourOf(record.ts * 1000);
      let rows = hours.get(hour);
      if (!rows) hours.set(hour, (rows = new Map()));
      let row = { route: record.route, method: record.method, class: record.class, decision: record.decision, operator };
      let key = JSON.stringify(row);
      if (!rows.has(key) && rows.size >= maxRows) {
        row = { route: "(other)", method: "OTHER", class: record.class, decision: record.decision, operator: "(other)" };
        key = JSON.stringify(row);
      }
      const have = rows.get(key);
      if (have) have.count++; else rows.set(key, { ...row, count: 1 });
    },
    /** Send every hour that has ended. */
    flushClosed() {
      const current = hourOf(now());
      for (const hour of [...hours.keys()].sort((a, b) => a - b)) if (hour < current) send(hour);
    },
    /** Send everything, the current hour too (shutdown). */
    flushAll() {
      for (const hour of [...hours.keys()].sort((a, b) => a - b)) send(hour);
    },
    /** Hours still held (for tests and diagnostics). */
    get pending() { return [...hours.keys()]; },
  };
}
