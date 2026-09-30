// @ludion/scan — the log-first Gate (spec ADR-016). Point it at access logs; it prints what
// automation touched what, and how much of it touched critical routes unverified.
//
// Zero network: it reads files and writes stdout, nothing else (SCAN-3).
import { createParser, detectFormat, FORMAT_IDS } from "./formats.mjs";
import { expandInputs, openLines, safeName } from "./lines.mjs";
import { createAggregator, classifyRecord, SCAN_CLASSES, CRITICAL_DEFINITION } from "./aggregate.mjs";

export { createParser, detectFormat, FORMAT_IDS, expandInputs, openLines, safeName, createAggregator, classifyRecord, SCAN_CLASSES, CRITICAL_DEFINITION };
export { renderText } from "./render.mjs";

const SAMPLE = 200;

/**
 * Parse one input, calling onRecord(record|false, lineIndex) for every request record.
 * @returns {Promise<{ format: string|null, syslog: boolean, gzip: boolean, records: number, parsed: number, nonRequests: number }>}
 */
export async function parseInput(file, { format, onRecord = () => {} } = {}) {
  const { gzip, batches } = await openLines(file);
  const it = batches[Symbol.asyncIterator]();
  const pending = [];
  if (!format) {
    const sample = [];
    for (let r; sample.length < SAMPLE && !(r = await it.next()).done;) { pending.push(r.value); sample.push(...r.value.slice(0, SAMPLE)); }
    format = detectFormat(sample.slice(0, SAMPLE));
    if (!format) {
      for (let r; !(r = await it.next()).done;); // drain
      return { format: null, syslog: false, gzip, records: 0, parsed: 0, nonRequests: 0 };
    }
  }
  const parser = createParser(format);
  let records = 0, parsed = 0, nonRequests = 0, index = 0, n = 0;
  const emit = (rec) => { n++; records++; if (rec) parsed++; onRecord(rec, index); };
  const feed = (batch) => {
    for (const line of batch) {
      n = 0;
      parser.parse(line, emit);
      if (!n) nonRequests++;
      index++;
    }
  };
  for (const b of pending) feed(b);
  for (let r; !(r = await it.next()).done;) feed(r.value);
  return { format: parser.id, syslog: parser.syslog, gzip, records, parsed, nonRequests };
}

const rate = (p, r) => (r ? Math.round((p / r) * 10_000) / 10_000 : null);

/**
 * Scan files and directories.
 * @param {string[]} inputs
 * @param {{ format?: string, top?: number }} [opts]
 */
export async function scan(inputs, opts = {}) {
  const agg = createAggregator();
  const files = [], unrecognized = [], notes = [];
  for (const file of expandInputs(inputs)) {
    const r = await parseInput(file, { format: opts.format, onRecord: (rec) => agg.add(rec) });
    const name = safeName(file);
    if (!r.format) { unrecognized.push({ name, gzip: r.gzip }); continue; }
    files.push({ name, format: r.format + (r.syslog ? " (syslog)" : ""), gzip: r.gzip, records: r.records, parsed: r.parsed,
      parse_rate: rate(r.parsed, r.records), skipped_non_requests: r.nonRequests });
  }
  const a = agg.finish({ top: opts.top });
  if (a.no_user_agent_field) notes.push(`${a.no_user_agent_field} requests came from a log format without a User-Agent field; they are counted as UNKNOWN. Log the User-Agent (e.g. Apache/nginx "combined") to see automation.`);
  if (a.classes.UNVERIFIED) notes.push(`${a.classes.UNVERIFIED} requests carried a Web Bot Auth signature. A log cannot verify a signature; a Gate can.`);
  return {
    tool: "ludion scan", v: 1,
    files, unrecognized,
    totals: { records: a.records, parsed: a.parsed, parse_rate: rate(a.parsed, a.records), skipped_non_requests: files.reduce((n, f) => n + f.skipped_non_requests, 0) },
    window: a.window,
    classes: a.classes, automation: a.automation, operators: a.operators, signals: a.signals, no_user_agent_field: a.no_user_agent_field,
    kinds: a.kinds, critical: a.critical, routes: a.routes, notes,
  };
}
