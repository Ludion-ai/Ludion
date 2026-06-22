/**
 * CLI: pnpm policy-audit
 * READ-ONLY reconciliation audit. Reads bench/results/*.json and prints the
 * gap report (markdown) to stdout. Writes nothing — no policy edit, no file
 * output. See bench/src/policy-audit.ts for the reconciliation logic.
 *
 * Lenient, like the supplier-table CLI: a file predating schema additions is
 * still audited; unreadable JSON is skipped with a stderr warning.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BenchDocument } from "../src/schema";
import { buildGapReport, renderGapReport, type AuditInput } from "../src/policy-audit";

const resultsDir = fileURLToPath(new URL("../results/", import.meta.url));

const inputs: AuditInput[] = [];

const files = readdirSync(resultsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

for (const file of files) {
  let doc: BenchDocument;
  try {
    doc = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as BenchDocument;
  } catch (e) {
    console.error(`skip \`${file}\`: unreadable JSON (${e instanceof Error ? e.message : e})`);
    continue;
  }
  if (!Array.isArray(doc.runs) || !Array.isArray(doc.sessions)) {
    console.error(`skip \`${file}\`: missing runs[]/sessions[]`);
    continue;
  }
  inputs.push({ file, doc });
}

const report = buildGapReport(inputs);
console.log(renderGapReport(report, inputs.length));
