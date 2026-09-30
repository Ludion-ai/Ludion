// @ludion/scan — the log-first Gate (spec ADR-016). Point it at access logs; it prints what
// automation touched what, and how much of it touched critical routes unverified.
//
// Zero network: it reads files and writes stdout, nothing else (SCAN-3). Parsing and counting
// live in core.mjs, which the browser scan runs unchanged (web.mjs); this file adds files.
import { createParser, detectFormat, FORMAT_IDS } from "./formats.mjs";
import { expandInputs, openLines, safeName } from "./lines.mjs";
import { createAggregator, classifyRecord, SCAN_CLASSES, CRITICAL_DEFINITION } from "./aggregate.mjs";
import { batchLines, parseBatches, createScan, maskName } from "./core.mjs";

export { createParser, detectFormat, FORMAT_IDS, expandInputs, openLines, safeName, createAggregator, classifyRecord, SCAN_CLASSES, CRITICAL_DEFINITION };
export { batchLines, parseBatches, createScan, maskName };
export { renderText } from "./render.mjs";

/**
 * Parse one input, calling onRecord(record|false, lineIndex) for every request record.
 * @returns {Promise<{ format: string|null, syslog: boolean, gzip: boolean, records: number, parsed: number, nonRequests: number }>}
 */
export async function parseInput(file, { format, onRecord } = {}) {
  const { gzip, batches } = await openLines(file);
  return { ...(await parseBatches(batches, { format, onRecord })), gzip };
}

/**
 * Scan files and directories.
 * @param {string[]} inputs
 * @param {{ format?: string, top?: number }} [opts]
 */
export async function scan(inputs, opts = {}) {
  const s = createScan(opts);
  for (const file of expandInputs(inputs)) await s.add(safeName(file), await openLines(file));
  return s.finish();
}
