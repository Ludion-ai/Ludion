// The pilot's records in the site's own D1: one row per automated request (observe.mjs), one row
// per daily report. The schema is created on first use, so a fresh database needs no migration step.
import { COLUMNS } from "./observe.mjs";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    rid TEXT NOT NULL, ts INTEGER NOT NULL, site TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL,
    class TEXT NOT NULL, decision TEXT NOT NULL, error TEXT, pressure INTEGER NOT NULL, diver TEXT, country TEXT,
    operator TEXT, token TEXT, reason TEXT, code TEXT, sig_agent TEXT, sig_lifetime INTEGER, sig_nonce INTEGER, probe TEXT, status INTEGER)`,
  "CREATE INDEX IF NOT EXISTS events_ts ON events (ts)",
  `CREATE TABLE IF NOT EXISTS reports (
    site TEXT NOT NULL, date TEXT NOT NULL, lang TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
    html TEXT NOT NULL, summary TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (site, date, lang))`,
];

/** Columns added after the first deploy, for a database made by an earlier version (2026-10-03: probes). */
export const ADDED = [["probe", "TEXT"], ["status", "INTEGER"]];

const INSERT = `INSERT INTO events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const PAGE = 5000;

const stores = new WeakMap();

/**
 * @param {D1Database} db  the EVENTS binding
 */
export function store(db) {
  let s = stores.get(db);
  if (s) return s;
  let ready;
  const ensure = () => (ready ??= (async () => {
    await db.batch(SCHEMA.map((q) => db.prepare(q)));
    for (const [name, type] of ADDED) {
      try { await db.prepare(`ALTER TABLE events ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e?.message ?? e))) throw e; } // already there
    }
  })().catch((e) => { ready = undefined; throw e; }));
  s = {
    ensure,
    async insert(row) {
      await ensure();
      await db.prepare(INSERT).bind(...COLUMNS.map((c) => row[c] ?? null)).run();
    },
    /** Rows with from ≤ ts < to (seconds), oldest first, a page at a time along the ts index. */
    async events(from, to) {
      await ensure();
      const out = [];
      let ts = from, row = -1;
      for (;;) {
        const { results } = await db.prepare(`SELECT rowid AS _row, ${COLUMNS.join(", ")} FROM events
          WHERE ts >= ?1 AND ts < ?2 AND (ts > ?1 OR rowid > ?3) ORDER BY ts, rowid LIMIT ${PAGE}`).bind(ts, to, row).all();
        for (const r of results) { ts = r.ts; row = r._row; delete r._row; out.push(r); }
        if (results.length < PAGE) return out;
      }
    },
    async saveReport({ site, date, lang, subject, text, html, summary, created }) {
      await ensure();
      await db.prepare("INSERT OR REPLACE INTO reports (site, date, lang, subject, text, html, summary, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(site, date, lang, subject, text, html, JSON.stringify(summary), created).run();
    },
    /** Forget events older than `before` (seconds). Reports are kept. */
    async prune(before) {
      await ensure();
      await db.prepare("DELETE FROM events WHERE ts < ?").bind(before).run();
    },
  };
  stores.set(db, s);
  return s;
}
