// Where a site counts what each Mandate has spent (spec §10.6, PRS-3). A Mandate's counted limit
// (per_day) is the site's, across all of its Gates: one record, shared by every Gate of the site,
// checked and updated in ONE atomic step so two Gates can never both spend the last charge. The
// Registry never holds it (spec §8 invariant 8: it does not know where an agent goes, let alone
// what it spends there).
//
// A ledger: { shared: true, charge(mandate, { at }) → Promise<{ ok: true, count } | { ok: false, reason }> }
//   count: charges in the 24 h before `at`, this one included. Only per_day needs a ledger; the
//   per-charge maximum and the currency hold at any Gate with no record (gate.charge checks them).
// A Gate with no ledger refuses a charge on a Mandate whose limits need counting: fail closed.
//
// memoryLedger() is the record for a site that runs exactly one Gate process (or shares one object
// between Gates in one process): it says so by being chosen. Several processes or machines need a
// ledger they all reach: @ludion/gate-node's sqliteLedger (one machine), or the site's own database
// behind this interface. Runtime-neutral.

import { DAY_MS } from "./mandate.mjs";

/** Is this a ledger a Gate can count on? */
export function isLedger(x) {
  return !!x && typeof x === "object" && x.shared === true && typeof x.charge === "function";
}

/**
 * The record for a site whose Gates all run in this one process. Bounded like the nonce cache: a
 * count inside its 24 h is never dropped (that would restart a per_day); when `maxMandates` live
 * counts are held, a new Mandate's charge is refused ("ledger_full"), never let through uncounted.
 * @param {{ maxMandates?: number }} [o]
 */
export function memoryLedger({ maxMandates = 100_000 } = {}) {
  const spent = new Map(); // jti -> charge times (ms), oldest first; least recently charged first
  const sweep = (t) => { for (const [k, times] of spent) if (times[times.length - 1] <= t - DAY_MS) spent.delete(k); };
  return {
    shared: true,
    kind: "memory",
    /** Synchronous inside: one JS process cannot interleave two of these. */
    async charge(m, { at }) {
      const known = spent.has(m.jti);
      const times = (spent.get(m.jti) ?? []).filter((x) => x > at - DAY_MS);
      const max = m.limits?.per_day;
      if (max != null && times.length >= max) return { ok: false, reason: "per_day" };
      if (!known && spent.size >= maxMandates) {
        sweep(at);
        if (spent.size >= maxMandates) return { ok: false, reason: "ledger_full" };
      }
      times.push(at);
      spent.delete(m.jti); spent.set(m.jti, times);
      return { ok: true, count: times.length };
    },
    size() { return spent.size; },
  };
}
