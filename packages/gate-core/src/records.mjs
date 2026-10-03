// Per-visit records stay on the site (ADR-038, spec §10.2-6, §12.9): kept for 7 days, then gone.
// The record is gate-core's metadataEvent; nothing of it leaves the Gate (hourly.mjs counts it).
// The default store is in memory (a process holds at most `max` records, oldest dropped first);
// a site may pass its own `{ put(record) }` (a file, its own database) — the Gate never awaits it.

export const RECORD_DAYS = 7;
export const DAY_MS = 86_400_000;

/**
 * @param {{ now?: () => number, days?: number, max?: number }} [o]
 * @returns {{ put(record: object): void, list(): object[], readonly size: number, purge(): void }}
 */
export function memoryRecords({ now = () => Date.now(), days = RECORD_DAYS, max = 100_000 } = {}) {
  let items = [];
  const expired = (r) => r.ts * 1000 <= now() - days * DAY_MS;
  // Records arrive in time order, so the expired ones are at the front: O(expired), not O(n), per put.
  // A record put out of order (a clock that stepped back) goes when it reaches the front.
  function purge() {
    let i = 0;
    while (i < items.length && expired(items[i])) i++;
    if (i) items = items.slice(i);
  }
  return {
    put(record) {
      items.push(record);
      purge();
      if (items.length > max) items = items.slice(items.length - max);
    },
    list() { purge(); return items.slice(); },
    get size() { return items.length; },
    purge,
  };
}
