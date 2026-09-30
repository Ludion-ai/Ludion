// SCAN-1 (+, pair SCAN-3): ≥99% of request records parse, per format and overall, detected
// without flags. "Parsed" means the fields the scan uses (method, target, status, User-Agent)
// equal the ground truth; the denominator is every request record (broken ones included),
// never format directives, build logs or other non-request lines.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { parseInput, createParser, FORMAT_IDS } from "@ludion/scan";
import { truths, runScan, CORPUS, FIXTURES } from "./support.mjs";

const TS = truths();
const REQUIRED = { nginx: ["combined"], apache: ["combined", "common"], caddy: ["caddy"], cloudflare: ["cloudflare"], vercel: ["vercel"],
  "aws-alb": ["alb"], "aws-cloudfront": ["cloudfront"], fastly: ["fastly"], iis: ["iis"] };

test("SCAN-1: the corpus covers the nine formats and the awkward cases", () => {
  for (const [vendor, formats] of Object.entries(REQUIRED)) {
    for (const f of formats) assert.ok(TS.some((t) => t.vendor === vendor && t.format === f), `missing ${vendor} ${f}`);
  }
  assert.ok(TS.some((t) => t.gzip), "a gzip file");
  assert.ok(TS.some((t) => t.crlf), "a CRLF file");
  assert.ok(TS.some((t) => t.bom), "a BOM file");
  assert.ok(TS.some((t) => t.non_requests > 0), "non-request lines");
  assert.ok(TS.filter((t) => t.records > t.parsed).length >= 8, "broken records (truncated last lines) in most files");
  // ≥250 records per file, so 1% is at least 2.5 lines and the threshold means something.
  for (const t of TS) assert.ok(t.records >= 250, `${t.file}: only ${t.records} records`);
});

test("SCAN-1: each file is detected without flags and ≥99% of its records parse correctly", async () => {
  const rows = [];
  for (const t of TS) {
    const got = [];
    const r = await parseInput(path.join(CORPUS, t.file), { onRecord: (rec, i) => (got[i] ??= []).push(rec) });
    let correct = 0, wrongShape = 0;
    t.lines.forEach((want, i) => {
      const g = got[i] ?? [];
      if (g.length !== want.length) { wrongShape++; return; }
      want.forEach((e, j) => {
        const x = g[j];
        if (e.ok && x && x.method === e.method && x.target === e.target && x.status === e.status && x.ua === e.ua) correct++;
      });
    });
    rows.push({ file: t.file, format: r.format, want: t.format, records: r.records, truthRecords: t.records, nonRequests: r.nonRequests,
      truthNonRequests: t.non_requests, reported: r.parsed / r.records, correct: correct / t.records, wrongShape });
  }
  for (const x of rows) {
    const at = `${x.file} (${x.format})`;
    assert.equal(x.format, x.want, `${x.file}: detected ${x.format}, expected ${x.want}`);
    assert.equal(x.records, x.truthRecords, `${at}: denominator`);
    assert.equal(x.nonRequests, x.truthNonRequests, `${at}: non-request lines`);
    assert.equal(x.wrongShape, 0, `${at}: lines split into the wrong number of records`);
    assert.ok(x.correct >= 0.99, `${at}: ${(x.correct * 100).toFixed(2)}% of records parsed correctly`);
    assert.ok(x.reported >= 0.99, `${at}: reported parse rate ${(x.reported * 100).toFixed(2)}%`);
    assert.ok(x.reported <= 1 && Math.abs(x.reported - x.correct) < 1e-9, `${at}: reports ${x.reported}, truly correct ${x.correct}`);
  }
});

test("SCAN-1: the CLI over the whole directory parses ≥99% overall and skips nothing", () => {
  const r = runScan([CORPUS, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  const records = TS.reduce((n, t) => n + t.records, 0), parsed = TS.reduce((n, t) => n + t.parsed, 0);
  assert.equal(rep.files.length, TS.length);
  assert.deepEqual(rep.unrecognized, []);
  assert.equal(rep.totals.records, records);
  assert.equal(rep.totals.parsed, parsed);
  assert.ok(rep.totals.parsed / rep.totals.records >= 0.99, `overall ${rep.totals.parse_rate}`);
  for (const f of rep.files) assert.ok(f.parse_rate >= 0.99, `${f.name}: ${f.parse_rate}`);
});

test("SCAN-1: lines that are not requests of the format never count as parsed", () => {
  const junk = ["hello world", "{", "{}", "[]", "[1,2]", '{"a":1}', "#", "#Fields:", "<134>", "- - - [] \"\" - -",
    "127.0.0.1 - - [not a date] \"GET / HTTP/1.1\" 200", "http 2026 x", "\u0000\u0001\u0002", "a".repeat(10_000)];
  for (const id of FORMAT_IDS) {
    const p = createParser(id);
    for (const line of junk) p.parse(line, (rec) => assert.equal(rec, false, `${id} accepted junk: ${JSON.stringify(line).slice(0, 40)}`));
  }
});

test("SCAN-1: the committed corpus and truth are exactly what generate.mjs writes (nothing hand-edited)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-gen-"));
  try {
    const r = spawnSync(process.execPath, [path.join(FIXTURES, "generate.mjs"), "--out", dir], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    for (const sub of ["corpus", "truth"]) {
      const want = fs.readdirSync(path.join(FIXTURES, sub)).sort(), got = fs.readdirSync(path.join(dir, sub)).sort();
      assert.deepEqual(got, want, sub);
      for (const f of want) {
        const read = (p) => { const b = fs.readFileSync(p); return b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b; };
        assert.ok(read(path.join(dir, sub, f)).equals(read(path.join(FIXTURES, sub, f))), `${sub}/${f} differs from the generator's output`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SCAN-1: a directory with other files reports them unrecognised; stdin works", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-scan1-"));
  try {
    const t = TS.find((x) => x.vendor === "nginx");
    fs.copyFileSync(path.join(CORPUS, t.file), path.join(dir, "access.log"));
    fs.writeFileSync(path.join(dir, "README.md"), "# not a log\n\nsome prose, not requests.\n");
    const r = runScan([dir, "--json"]);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(rep.unrecognized.map((u) => u.name), ["README.md"]);
    assert.equal(rep.totals.records, t.records);
    const s = runScan(["-", "--json"], { input: fs.readFileSync(path.join(CORPUS, t.file)) });
    assert.equal(JSON.parse(s.stdout).totals.parsed, t.parsed);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
