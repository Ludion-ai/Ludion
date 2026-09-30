// Day windows in a site's time zone (spec §11.8 "yesterday" is the site's yesterday, not UTC's).
// Runtime-neutral: Intl only. DST days are 23 or 25 hours long; the window follows the zone.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @returns {boolean} */
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** @returns {boolean} a real calendar date written YYYY-MM-DD */
export function isValidDate(date) {
  const m = DATE.exec(date ?? "");
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === date;
}

function wallClock(tz, t) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of `tz` from UTC at instant `t` (ms): local wall clock − UTC. */
function offsetAt(tz, t) {
  const w = wallClock(tz, t);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local midnight starting `date` in `tz`. */
export function startOfDay(date, tz) {
  const m = DATE.exec(date);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let t = wall - offsetAt(tz, wall);
  t = wall - offsetAt(tz, t); // second pass: the offset at the answer, not at the guess
  return t;
}

/** @returns {string} the calendar date `days` after `date` */
export function addDays(date, days) {
  const m = DATE.exec(date);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10);
}

/** [start, end) of `date` in `tz`, as UTC milliseconds. */
export function dayWindow(date, tz) {
  return { start: startOfDay(date, tz), end: startOfDay(addDays(date, 1), tz) };
}

/** Today's date in `tz` at instant `now`. */
export function dateIn(tz, now = Date.now()) {
  const w = wallClock(tz, now);
  return `${String(w.y).padStart(4, "0")}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
