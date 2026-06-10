import type { BenchDocument, RunRow } from "./schema";
import { median, round } from "./metrics";

/**
 * "Supplier quality table" generator (Gate 0 data asset, 2026-06-10).
 * Pure function: results JSON in, markdown out — the node CLI lives in
 * scripts/supplier-table.ts, this module stays runtime-agnostic and testable.
 *
 * Rows  = device × engine × model × prompt × cache_state.
 * Cells = backend / median decode_tps / median prefill_tps / median ttft /
 *         error rate / KV sizing. Groups with zero successful runs are kept
 *         and marked × — failures are routing-table data, not noise.
 */

export interface SupplierInput {
  /** Device label parsed from the filename ({device-label}-{timestamp}.json). */
  device: string;
  /** Source filename, listed in the generated table for traceability. */
  file: string;
  doc: BenchDocument;
}

interface Group {
  device: string;
  engine: string;
  modelId: string;
  prompt: string;
  cacheState: string;
  rows: RunRow[];
}

const NA = "–";
const FAIL = "×";

function fmtMedian(rows: RunRow[], pick: (r: RunRow) => number | null, anyOk: boolean): string {
  const values = rows
    .filter((r) => r.error === null)
    .map(pick)
    .filter((v): v is number => v !== null);
  if (values.length > 0) return String(round(median(values), 1));
  return anyOk ? NA : FAIL;
}

function distinct(values: string[]): string {
  return [...new Set(values)].join(", ") || NA;
}

/** Tolerates pre-2026-06-10 exports where the kv fields do not exist. */
function fmtKv(rows: RunRow[]): string {
  return distinct(
    rows
      .filter((r) => r.error === null || rows.every((x) => x.error !== null))
      .map((r) => `${r.kv_context_window ?? NA}/${r.prefill_chunk ?? NA}`),
  );
}

export function buildSupplierTable(inputs: SupplierInput[], warnings: string[] = []): string {
  const groups = new Map<string, Group>();
  for (const { device, doc } of inputs) {
    for (const run of doc.runs) {
      const key = [device, run.engine, run.model_id, run.prompt, run.cache_state].join("|");
      let group = groups.get(key);
      if (!group) {
        group = {
          device,
          engine: run.engine,
          modelId: run.model_id,
          prompt: run.prompt,
          cacheState: run.cache_state,
          rows: [],
        };
        groups.set(key, group);
      }
      group.rows.push(run);
    }
  }

  const sorted = [...groups.values()].sort((a, b) =>
    [a.device, a.engine, a.modelId, a.prompt, a.cacheState]
      .join("|")
      .localeCompare([b.device, b.engine, b.modelId, b.prompt, b.cacheState].join("|")),
  );

  const lines: string[] = [
    "# Supplier quality table — Gate 0",
    "",
    `Generated from ${inputs.length} result file(s):`,
    ...inputs.map((i) => `- \`${i.file}\` (${i.doc.runs.length} runs, collected ${i.doc.collected_at})`),
    "",
    "× = no successful run in the group (error rows only). – = not reported.",
    "",
    "| device | engine | model | prompt | cache | backend | decode_tps (med) | prefill_tps (med) | ttft_ms (med) | error rate | kv (ctx/chunk) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  for (const g of sorted) {
    const errors = g.rows.filter((r) => r.error !== null).length;
    const anyOk = errors < g.rows.length;
    const backend = distinct(
      g.rows.map((r) => r.backend).filter((b): b is NonNullable<typeof b> => b !== null),
    );
    lines.push(
      `| ${g.device} | ${g.engine} | ${g.modelId} | ${g.prompt} | ${g.cacheState} | ${anyOk ? backend : `${FAIL} ${backend}`} | ${fmtMedian(g.rows, (r) => r.decode_tps, anyOk)} | ${fmtMedian(g.rows, (r) => r.prefill_tps, anyOk)} | ${fmtMedian(g.rows, (r) => r.ttft_ms, anyOk)} | ${errors}/${g.rows.length} (${Math.round((errors / g.rows.length) * 100)}%) | ${fmtKv(g.rows)} |`,
    );
  }

  if (sorted.length === 0) {
    lines.push("", "_No runs found. Place exported JSONs in bench/results/ (see README.md)._");
  }

  if (warnings.length > 0) {
    lines.push("", "## Validation warnings", "", ...warnings.map((w) => `- ${w}`));
  }

  lines.push("");
  return lines.join("\n");
}
