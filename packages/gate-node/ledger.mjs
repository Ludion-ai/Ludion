// A Mandate ledger every Gate process on one machine shares (spec §10.6, PRS-3): an SQLite file.
// Each charge is one IMMEDIATE transaction — count this Mandate's charges in the last 24 h, refuse
// at per_day, else record — so concurrent charges in any number of processes are serialised by the
// database's write lock and never overspend. Node ≥ 22.13 (node:sqlite). Several machines need a
// database they all reach behind the same interface (see @ludion/gate-core's ledger.mjs).
const DAY_MS = 86_400_000;
const LOCKED = /locked|busy/i;

/**
 * @param {string} file  the database file (created if missing); every Gate of the site names the same one
 * @param {{ busyTimeoutMs?: number }} [o]  how long one open or one charge may wait for the others
 */
export async function sqliteLedger(file, { busyTimeoutMs = 10_000 } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  /**
   * Run `step` until it is not refused for a lock another process holds, up to busyTimeoutMs.
   * SQLite's own busy handler does not cover every case (a brand-new file's schema, a lock it will
   * not wait for to avoid deadlock), and a slow machine with many processes starting together hits
   * them (PRS-3, found on loop-windows). A refused step has done nothing: its transaction rolled back.
   */
  async function retrying(step) {
    const deadline = Date.now() + busyTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try { return step(); } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* nothing begun */ }
        if (!LOCKED.test(String(e?.message)) || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, Math.min(200, 5 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random())));
      }
    }
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
  // A site starts its Gate processes together: they all open a new file at once. The schema goes in
  // under the write lock (the default rollback journal: a journal_mode switch needs the file to
  // itself and fails at once instead of waiting).
  const statements = await retrying(() => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS ludion_mandate_charges (jti TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS ludion_mandate_charges_jti_at ON ludion_mandate_charges (jti, at)");
    db.exec("COMMIT");
    return {
      count: db.prepare("SELECT COUNT(*) AS n FROM ludion_mandate_charges WHERE jti = ? AND at > ?"),
      record: db.prepare("INSERT INTO ludion_mandate_charges (jti, at) VALUES (?, ?)"),
      expire: db.prepare("DELETE FROM ludion_mandate_charges WHERE at <= ?"),
    };
  });
  const { count, record, expire } = statements;
  return {
    shared: true,
    kind: "sqlite",
    charge(m, { at }) {
      return retrying(() => {
        db.exec("BEGIN IMMEDIATE");
        const n = Number(count.get(m.jti, at - DAY_MS).n);
        const max = m.limits?.per_day;
        if (max != null && n >= max) { db.exec("ROLLBACK"); return { ok: false, reason: "per_day" }; }
        record.run(m.jti, at);
        expire.run(at - DAY_MS);
        db.exec("COMMIT");
        return { ok: true, count: n + 1 };
      });
    },
    close() { db.close(); },
  };
}
