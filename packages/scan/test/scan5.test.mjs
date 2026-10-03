// SCAN-5 (−, the pair of SCAN-1, property parse-rate): the parse rate never flatters. A copy of the
// corpus with a known set of request records damaged (each cut to its first third) must report
// exactly those as unparsed: the damaged lines and no others yield an unparsed record, the
// denominator does not shrink (a damaged record is not a "non-request line"), parsed drops by the
// damaged count, the reported rate is the true one, and every file damaged past 1% is reported under
// 99% — per file and through the CLI. The judge is tried on planted parsers first: one that counts
// every record as parsed, one that hides damaged records as non-requests, one that loses a record.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parseInput } from "@ludion/scan";
import { truths, runScan, CORPUS } from "./support.mjs";

const TS = truths();
const SAMPLE = 200; // the lines format detection reads (core.mjs); damage starts after them
const SHARE = 0.03; // of a file's records: past the 1% SCAN-1 allows, so the rate must fall under 99%

/** Damage a copy of fixture `t` into `dir`: returns the damaged line indices. */
function damage(t, dir) {
  const src = fs.readFileSync(path.join(CORPUS, t.file));
  const text = (t.gzip ? zlib.gunzipSync(src) : src).toString("utf8");
  const lines = text.split("\n");
  // Vercel's drain writes several lines per request and the parser keeps the first (by requestId):
  // damaging one of those would let its twin stand in, which is right. Damage single-line requests.
  const ids = new Map();
  if (t.format === "vercel") for (const l of lines) { try { const id = JSON.parse(l).requestId; if (id) ids.set(id, (ids.get(id) ?? 0) + 1); } catch {} }
  const twinned = (l) => { try { return (ids.get(JSON.parse(l).requestId) ?? 0) > 1; } catch { return false; } };
  const candidates = [];
  t.lines.forEach((recs, i) => { if (i >= SAMPLE && recs.length === 1 && recs[0].ok && lines[i]?.replace(/\r$/, "").length >= 12 && !twinned(lines[i])) candidates.push(i); });
  const want = Math.ceil(t.records * SHARE);
  assert.ok(candidates.length >= want, `${t.file}: only ${candidates.length} damageable records after line ${SAMPLE}`);
  const step = candidates.length / want, hit = new Set();
  for (let k = 0; k < want; k++) hit.add(candidates[Math.floor(k * step)]);
  for (const i of hit) {
    const cr = lines[i].endsWith("\r") ? "\r" : "", body = lines[i].slice(0, lines[i].length - cr.length);
    lines[i] = body.slice(0, Math.floor(body.length / 3)) + cr;
  }
  const out = Buffer.from(lines.join("\n"), "utf8");
  fs.writeFileSync(path.join(dir, t.file), t.gzip ? zlib.gzipSync(out) : out);
  return hit;
}

/** What is wrong with one damaged file's result `r` (parseInput's), given its truth and damage. */
export function judge(r, t, hit, unparsedAt) {
  const out = [], d = hit.size;
  if (r.format !== t.format) out.push(`detected ${r.format}, not ${t.format}`);
  if (r.records !== t.records) out.push(`denominator ${r.records}, not ${t.records}: damaged records went missing or were hidden as non-requests`);
  if (r.nonRequests !== t.non_requests) out.push(`${r.nonRequests} non-request lines, not ${t.non_requests}`);
  if (r.parsed !== t.parsed - d) out.push(`parsed ${r.parsed}, not ${t.parsed - d}: damaged records counted as parsed`);
  const rate = r.records ? r.parsed / r.records : 1, truth = (t.parsed - d) / t.records;
  if (Math.abs(rate - truth) > 1e-9) out.push(`reports ${rate.toFixed(4)}, truly ${truth.toFixed(4)}`);
  if (truth < 0.99 && rate >= 0.99) out.push(`reported at or over 99% while truly ${(truth * 100).toFixed(2)}%`);
  if (unparsedAt) {
    const missed = [...hit].filter((i) => !unparsedAt.has(i)), extra = [...unparsedAt].filter((i) => !hit.has(i) && t.lines[i]?.every((x) => x.ok));
    if (missed.length) out.push(`damaged lines not reported unparsed: ${missed.slice(0, 5).join(", ")}`);
    if (extra.length) out.push(`undamaged lines reported unparsed: ${extra.slice(0, 5).join(", ")}`);
  }
  return out;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-scan5-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const DAMAGE = new Map(TS.map((t) => [t.file, damage(t, dir)]));
async function parseDamaged(t) {
  const unparsedAt = new Set();
  const r = await parseInput(path.join(dir, t.file), { onRecord: (rec, i) => { if (!rec) unparsedAt.add(i); } });
  return { r, unparsedAt };
}

test("SCAN-5: the judge catches a parse rate that flatters (planted parsers)", async () => {
  const t = TS.find((x) => x.vendor === "nginx");
  const hit = DAMAGE.get(t.file);
  const { r, unparsedAt } = await parseDamaged(t);
  assert.deepEqual(judge(r, t, hit, unparsedAt), [], "control: the real parser on the damaged copy");
  const planted = [
    ["counts every record as parsed", { ...r, parsed: r.records }, unparsedAt, /counted as parsed/],
    ["hides damaged records as non-requests", { ...r, records: r.records - hit.size, nonRequests: r.nonRequests + hit.size, parsed: r.parsed }, unparsedAt, /hidden as non-requests/],
    ["loses a record", { ...r, records: r.records - 1, parsed: r.parsed - 1 }, unparsedAt, /denominator/],
    ["reports undamaged lines as the unparsed ones", r, new Set([...unparsedAt].map((i) => i - 1)), /damaged lines not reported unparsed/],
  ];
  for (const [what, fake, at, why] of planted) assert.ok(judge(fake, t, hit, at).some((p) => why.test(p)), `${what} → ${JSON.stringify(judge(fake, t, hit, at))}`);
});

test("SCAN-5: in every format, exactly the damaged records are unparsed and the rate falls with them, under 99%", async () => {
  const rows = [];
  for (const t of TS) {
    const hit = DAMAGE.get(t.file);
    const { r, unparsedAt } = await parseDamaged(t);
    assert.deepEqual(judge(r, t, hit, unparsedAt), [], t.file);
    rows.push(`${t.format} ${(r.parsed / r.records * 100).toFixed(1)}%`);
  }
  console.log(`SCAN-5: ${TS.length} files with ${Math.round(SHARE * 100)}% of records damaged report exactly them unparsed (${rows.join(", ")})`);
});

test("SCAN-5: the CLI over the damaged corpus reports the true totals and every file under 99%", () => {
  const r = runScan([dir, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  const records = TS.reduce((n, t) => n + t.records, 0), parsed = TS.reduce((n, t) => n + t.parsed - DAMAGE.get(t.file).size, 0);
  assert.equal(rep.files.length, TS.length);
  assert.equal(rep.totals.records, records, "denominator");
  assert.equal(rep.totals.parsed, parsed, "parsed");
  for (const f of rep.files) assert.ok(f.parse_rate < 0.99, `${f.name}: reported ${f.parse_rate}`);
  assert.ok(rep.totals.parsed / rep.totals.records < 0.99);
});
