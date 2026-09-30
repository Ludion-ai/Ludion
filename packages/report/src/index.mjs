// @ludion/report — the daily report (spec §11.8), the first product a site owner sees.
//
// Reads the Gate's metadata events (spec §11.7) and nothing else; writes a summary (JSON) and
// email-ready renderings in Japanese and English (HTML and plain text). Sending is not this
// package's job. Zero network.
import { parseEvents, summarize, sitesOf, readEvent, count, displayRoute, agentName, REPORT_CLASSES, TOP_AGENTS, TOP_ROUTES, UNNAMED } from "./summarize.mjs";
import { renderText, renderHtml, subject, model, fmt, GATE_URL } from "./render.mjs";
import { dayWindow, addDays, dateIn, isValidDate, isValidTimeZone } from "./window.mjs";
import { STRINGS, LANGS } from "./strings.mjs";

export {
  parseEvents, summarize, sitesOf, readEvent, count, displayRoute, agentName, REPORT_CLASSES, TOP_AGENTS, TOP_ROUTES, UNNAMED,
  renderText, renderHtml, subject, model, fmt, GATE_URL, dayWindow, addDays, dateIn, isValidDate, isValidTimeZone, STRINGS, LANGS,
};

/**
 * Everything for one site and day, from NDJSON text.
 * @param {string} text
 * @param {{ date: string, tz?: string, site?: string }} opts
 */
export function buildReport(text, { date, tz = "UTC", site } = {}) {
  if (!isValidTimeZone(tz)) throw new RangeError(`unknown time zone: ${tz}`);
  if (!isValidDate(date)) throw new RangeError(`not a date (YYYY-MM-DD): ${date}`);
  const { events, skipped } = parseEvents(text);
  const sites = sitesOf(events);
  if (!site) {
    if (sites.length > 1) throw new RangeError(`the events hold ${sites.length} sites; choose one with --site`);
    site = sites[0] ?? "(no site)";
  }
  return summarize(events, { site, date, tz, skipped });
}
