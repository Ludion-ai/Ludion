/**
 * Gate 4 ② — the public data dashboard (`/data`).
 *
 * Reads the precomputed, privacy-preserving /v1/aggregate rollup and renders the
 * three rollups the spec names: device-class table, routing-rule firing, and
 * failure modes. Monochrome Gate 2.6 tokens, an HTML table + CSS bars only — no
 * charting library (decisions F-4). Degrades to an honest status line if the
 * endpoint is unreachable; renders "no data yet" cleanly when empty (F-6).
 */
import "./data.css";
import { collectorUrl } from "./submit";

interface ClassRollup {
  count: number;
  local_eligible: number;
  completed: number;
  median_decode_tps: number | null;
  median_prefill_tps: number | null;
}
interface Aggregate {
  schema: string;
  updated_at: string | null;
  total_submissions: number;
  by_device_class: Record<string, ClassRollup>;
  by_rule: Record<string, number>;
  failure_modes: { completed: number; tab_death: number; init_fail: number; other: number };
}

const CLASS_ORDER = ["desktop", "android-chromium", "ios-webkit", "webview-iab", "other"] as const;
const CLASS_LABEL: Record<string, string> = {
  desktop: "Desktop",
  "android-chromium": "Android (Chromium)",
  "ios-webkit": "iOS (WebKit)",
  "webview-iab": "In-app browser",
  other: "Other",
};

const RULE_ORDER = ["R1", "R2", "R3", "R4", "R5", "R6"] as const;
const RULE_LABEL: Record<string, string> = {
  R1: "R1 · in-app browser → server",
  R2: "R2 · no WebGPU → server",
  R3: "R3 · iOS → server",
  R4: "R4 · desktop WebGPU → local",
  R5: "R5 · Android WebGPU → local (short)",
  R6: "R6 · default → server",
};

const FAILURE_ORDER = ["completed", "tab_death", "init_fail", "other"] as const;
const FAILURE_LABEL: Record<string, string> = {
  completed: "Completed ≥1 local run",
  tab_death: "Tab death (OOM / kill)",
  init_fail: "Init failure",
  other: "Other failure",
};

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function pct(n: number, d: number): string {
  return d === 0 ? "–" : `${Math.round((n / d) * 100)}%`;
}

function tps(v: number | null): string {
  return v === null ? "–" : `${v}`;
}

/** A table cell; a numeric value optionally backed by a proportional bar. */
function cell(text: string, fraction?: number): HTMLTableCellElement {
  const td = document.createElement("td");
  if (fraction !== undefined) {
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    td.appendChild(bar);
  }
  const label = document.createElement("span");
  label.className = "cell-label";
  label.textContent = text;
  td.appendChild(label);
  return td;
}

function headRow(labels: string[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const l of labels) {
    const th = document.createElement("th");
    th.textContent = l;
    tr.appendChild(th);
  }
  return tr;
}

function renderClassTable(agg: Aggregate): void {
  const table = $("class-table") as HTMLTableElement;
  table.replaceChildren();
  table.appendChild(
    headRow(["Class", "Devices", "LOCAL-eligible", "Completed", "Median decode", "Median prefill"]),
  );
  for (const key of CLASS_ORDER) {
    const r = agg.by_device_class[key] ?? {
      count: 0,
      local_eligible: 0,
      completed: 0,
      median_decode_tps: null,
      median_prefill_tps: null,
    };
    const tr = document.createElement("tr");
    const nameTd = document.createElement("th");
    nameTd.scope = "row";
    nameTd.textContent = CLASS_LABEL[key] ?? key;
    tr.appendChild(nameTd);
    tr.appendChild(cell(`${r.count}`));
    tr.appendChild(cell(pct(r.local_eligible, r.count), r.count === 0 ? 0 : r.local_eligible / r.count));
    tr.appendChild(cell(pct(r.completed, r.count), r.count === 0 ? 0 : r.completed / r.count));
    tr.appendChild(cell(tps(r.median_decode_tps)));
    tr.appendChild(cell(tps(r.median_prefill_tps)));
    table.appendChild(tr);
  }
}

function renderCountTable(
  id: string,
  order: readonly string[],
  labels: Record<string, string>,
  counts: Record<string, number>,
  total: number,
): void {
  const table = $(id) as HTMLTableElement;
  table.replaceChildren();
  table.appendChild(headRow(["", "Count", "Share"]));
  for (const key of order) {
    const n = counts[key] ?? 0;
    const tr = document.createElement("tr");
    const nameTd = document.createElement("th");
    nameTd.scope = "row";
    nameTd.textContent = labels[key] ?? key;
    tr.appendChild(nameTd);
    tr.appendChild(cell(`${n}`));
    tr.appendChild(cell(pct(n, total), total === 0 ? 0 : n / total));
    table.appendChild(tr);
  }
}

function renderUpdated(agg: Aggregate): void {
  const el = $("updated");
  if (agg.updated_at === null) {
    el.textContent = `${agg.total_submissions} submissions · not yet computed`;
    return;
  }
  const when = new Date(agg.updated_at);
  el.textContent = `${agg.total_submissions} submissions · updated ${when.toLocaleString()}`;
}

function showSections(show: boolean): void {
  for (const id of ["class-section", "rule-section", "failure-section"]) {
    $(id).classList.toggle("hidden", !show);
  }
}

async function boot(): Promise<void> {
  const status = $("status");
  const base = collectorUrl();
  if (base === null) {
    status.textContent = "The public dataset endpoint is not configured for this build.";
    showSections(false);
    return;
  }
  let agg: Aggregate;
  try {
    const res = await fetch(`${base}/v1/aggregate`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    agg = (await res.json()) as Aggregate;
  } catch {
    status.textContent = "The public dataset is temporarily unavailable. Try again shortly.";
    showSections(false);
    return;
  }

  renderUpdated(agg);
  if (agg.total_submissions === 0) {
    status.textContent = "No measurements yet — be the first to measure your device.";
    showSections(false);
    return;
  }
  renderClassTable(agg);
  renderCountTable("rule-table", RULE_ORDER, RULE_LABEL, agg.by_rule, agg.total_submissions);
  renderCountTable(
    "failure-table",
    FAILURE_ORDER,
    FAILURE_LABEL,
    agg.failure_modes,
    agg.total_submissions,
  );
  showSections(true);
  status.textContent = "";
}

void boot();
