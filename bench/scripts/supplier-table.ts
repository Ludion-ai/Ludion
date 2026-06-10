/**
 * CLI: pnpm supplier-table
 * Reads bench/results/*.json (operator-archived exports, see results/README.md)
 * and regenerates bench/results/supplier-table.md.
 *
 * Lenient by design: exports predating schema additions fail strict validation
 * but their runs are still tabulated; every validation error is surfaced in a
 * warnings section instead of being silently dropped.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateBenchDocument, type BenchDocument } from "../src/schema";
import { buildSupplierTable, type SupplierInput } from "../src/supplier-table";

const resultsDir = fileURLToPath(new URL("../results/", import.meta.url));
const FILENAME_RE = /^(.+)-(\d{8}T\d{6})\.json$/;

const inputs: SupplierInput[] = [];
const warnings: string[] = [];

const files = readdirSync(resultsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

for (const file of files) {
  const match = FILENAME_RE.exec(file);
  if (!match) {
    warnings.push(
      `\`${file}\`: filename does not match {device-label}-{YYYYMMDDTHHMMSS}.json; using full basename as device label`,
    );
  }
  const device = match?.[1] ?? file.replace(/\.json$/, "");

  let doc: BenchDocument;
  try {
    doc = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as BenchDocument;
  } catch (e) {
    warnings.push(`\`${file}\`: unreadable JSON, skipped (${e instanceof Error ? e.message : e})`);
    continue;
  }

  const result = validateBenchDocument(doc);
  if (!result.ok) {
    warnings.push(
      `\`${file}\`: ${result.errors.length} schema deviation(s) — included anyway. First: ${result.errors[0]}`,
    );
  }
  if (!Array.isArray(doc.runs)) {
    warnings.push(`\`${file}\`: no runs[] array, skipped`);
    continue;
  }
  inputs.push({ device, file, doc });
}

const out = join(resultsDir, "supplier-table.md");
writeFileSync(out, buildSupplierTable(inputs, warnings));
console.log(
  `supplier-table: ${inputs.length} file(s), ${inputs.reduce((n, i) => n + i.doc.runs.length, 0)} runs, ${warnings.length} warning(s) -> ${out}`,
);
