// The platform-neutral half of the scan: decoded text in, report out. Nothing here imports
// node:*, so the browser scan (site /scan, WEB-4) runs exactly this code, and the CLI adds only
// how bytes are read (lines.mjs). Nothing here opens a socket.
import { createParser, detectFormat } from "./formats.mjs";
import { createAggregator } from "./aggregate.mjs";

const SAMPLE = 200;

/**
 * Split decoded text chunks into batches of lines (one batch per chunk). A leading BOM is
 * dropped; empty lines are dropped; `\r` before `\n` is dropped; a last line without a newline
 * is kept.
 * @param {AsyncIterable<string>} chunks
 * @returns {AsyncGenerator<string[]>}
 */
export async function* batchLines(chunks) {
  let rest = "", first = true;
  for await (const chunk of chunks) {
    let s = rest + chunk;
    if (first && s) { if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); first = false; }
    const out = [];
    let start = 0;
    for (let nl = s.indexOf("\n"); nl >= 0; nl = s.indexOf("\n", start)) {
      const end = nl > start && s.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (end > start) out.push(s.slice(start, end));
      start = nl + 1;
    }
    rest = s.slice(start);
    if (out.length) yield out;
  }
  if (rest.endsWith("\r")) rest = rest.slice(0, -1);
  if (rest) yield [rest];
}

/**
 * Parse one input's line batches, calling onRecord(record|false, lineIndex) for every request
 * record. The format is detected from the first lines unless given.
 * @param {AsyncIterable<string[]>} batches
 * @returns {Promise<{ format: string|null, syslog: boolean, records: number, parsed: number, nonRequests: number }>}
 */
export async function parseBatches(batches, { format, onRecord = () => {} } = {}) {
  const it = batches[Symbol.asyncIterator]();
  const pending = [];
  if (!format) {
    const sample = [];
    for (let r; sample.length < SAMPLE && !(r = await it.next()).done;) { pending.push(r.value); sample.push(...r.value.slice(0, SAMPLE)); }
    format = detectFormat(sample.slice(0, SAMPLE));
    if (!format) {
      for (let r; !(r = await it.next()).done;); // drain
      return { format: null, syslog: false, records: 0, parsed: 0, nonRequests: 0 };
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
  return { format: parser.id, syslog: parser.syslog, records, parsed, nonRequests };
}

/**
 * A file name that is safe to print, given its base name: IP addresses masked (ALB and ELB put
 * the node's IP in the name), long digit runs (account IDs) masked.
 */
export function maskName(base) {
  return base
    .replace(/(?<![0-9])\d{1,3}(?:[._-]\d{1,3}){3}(?![0-9])/g, "x.x.x.x")
    .replace(/(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/gi, "x:x::x")
    .replace(/\d{9,}/g, "#");
}

const rate = (p, r) => (r ? Math.round((p / r) * 10_000) / 10_000 : null);

/**
 * One scan over any number of inputs, fed in order. The report never holds a raw record.
 * @param {{ format?: string, top?: number }} [opts]
 */
export function createScan(opts = {}) {
  const agg = createAggregator();
  const files = [], unrecognized = [];
  return {
    /**
     * @param {string} name a printable name (see maskName)
     * @param {{ gzip: boolean, batches: AsyncIterable<string[]> }} input
     */
    async add(name, { gzip, batches }) {
      const r = await parseBatches(batches, { format: opts.format, onRecord: (rec) => agg.add(rec) });
      if (!r.format) { unrecognized.push({ name, gzip }); return; }
      files.push({ name, format: r.format + (r.syslog ? " (syslog)" : ""), gzip, records: r.records, parsed: r.parsed,
        parse_rate: rate(r.parsed, r.records), skipped_non_requests: r.nonRequests });
    },
    finish() {
      const a = agg.finish({ top: opts.top });
      const notes = [];
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
    },
  };
}
