// A Mandate ledger every Gate process on one machine shares (spec §10.6, PRS-3): an SQLite file.
// Each charge is one IMMEDIATE transaction — count this Mandate's charges in the last 24 h, refuse
// at per_day, else record — so concurrent charges in any number of processes are serialised by the
// database's write lock and never overspend. Node ≥ 22.13 (node:sqlite). Several machines need a
// database they all reach behind the same interface (see @ludion/gate-core's ledger.mjs).
const DAY_MS = 86_400_000;

/**
 * @param {string} file  the database file (created if missing); every Gate of the site names the same one
 * @param {{ busyTimeoutMs?: number }} [o]
 */
export async function sqliteLedger(file, { busyTimeoutMs = 5000 } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS ludion_mandate_charges (jti TEXT NOT NULL, at INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS ludion_mandate_charges_jti_at ON ludion_mandate_charges (jti, at)");
  const count = db.prepare("SELECT COUNT(*) AS n FROM ludion_mandate_charges WHERE jti = ? AND at > ?");
  const record = db.prepare("INSERT INTO ludion_mandate_charges (jti, at) VALUES (?, ?)");
  const expire = db.prepare("DELETE FROM ludion_mandate_charges WHERE at <= ?");
  return {
    shared: true,
    kind: "sqlite",
    async charge(m, { at }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const n = Number(count.get(m.jti, at - DAY_MS).n);
        const max = m.limits?.per_day;
        if (max != null && n >= max) { db.exec("ROLLBACK"); return { ok: false, reason: "per_day" }; }
        record.run(m.jti, at);
        expire.run(at - DAY_MS);
        db.exec("COMMIT");
        return { ok: true, count: n + 1 };
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      }
    },
    close() { db.close(); },
  };
}
