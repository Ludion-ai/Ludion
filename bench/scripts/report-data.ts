/**
 * CLI: pnpm report-data
 *
 * Gate 2 decisions C-3/C-4: every number in README.md and
 * docs/report/2026-06-browser-inference-field-notes.md lives inside a
 * generated block and is computed from exactly two sources:
 *
 *   1. the archived measurement records in bench/results/*.json,
 *   2. the pinned engine config (@mlc-ai/web-llm@0.2.84 prebuiltAppConfig).
 *
 * Blocks are delimited by `<!-- gen:NAME -->` / `<!-- /gen:NAME -->` markers;
 * this script rewrites the block bodies in place. CI re-runs it and fails on
 * `git diff --exit-code`, which structurally forbids hand-typed numbers.
 * The script itself fails if a defined block is never used, if a target file
 * references an unknown block, or if the pinned engine version drifts.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateBenchDocument, type BenchDocument, type RunRow } from "../src/schema";
import { median, round } from "../src/metrics";

const benchDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(benchDir, "..");
const resultsDir = join(benchDir, "results");

const TARGET_FILES = [
  join(repoRoot, "docs/report/2026-06-browser-inference-field-notes.md"),
  join(repoRoot, "README.md"),
];

const PINNED_WEBLLM_VERSION = "0.2.84";
const FILENAME_RE = /^(.+)-(\d{8}T\d{6})\.json$/;
const NA = "–";

// --- load archived results ----------------------------------------------------

interface ResultFile {
  file: string;
  device: string;
  stamp: string;
  doc: BenchDocument;
}

const files: ResultFile[] = [];
for (const file of readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort()) {
  const m = FILENAME_RE.exec(file);
  if (!m) throw new Error(`report-data: ${file} does not match {device}-{stamp}.json`);
  const doc = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as BenchDocument;
  const v = validateBenchDocument(doc);
  if (!v.ok) {
    // Same leniency as supplier-table: archived pre-amendment exports are
    // included; their deviations are already surfaced in supplier-table.md.
    console.warn(`report-data: ${file}: ${v.errors.length} schema deviation(s), included anyway`);
  }
  files.push({ file, device: m[1]!, stamp: m[2]!, doc });
}

const byDevice = (d: string): ResultFile[] => files.filter((f) => f.device === d);
const one = (d: string): ResultFile => {
  const list = byDevice(d);
  if (list.length !== 1) throw new Error(`report-data: expected exactly 1 file for ${d}, got ${list.length}`);
  return list[0]!;
};

const okRuns = (rs: RunRow[]): RunRow[] => rs.filter((r) => r.error === null);
const med = (rs: RunRow[], pick: (r: RunRow) => number | null, digits = 1): string => {
  const m = median(okRuns(rs).map(pick).filter((v): v is number => v !== null));
  return m === null ? NA : String(round(m, digits));
};
const medNum = (rs: RunRow[], pick: (r: RunRow) => number | null): number => {
  const m = median(okRuns(rs).map(pick).filter((v): v is number => v !== null));
  if (m === null) throw new Error("report-data: median over empty set");
  return m;
};

// --- pinned engine config -----------------------------------------------------

const webllmDir = join(benchDir, "node_modules/@mlc-ai/web-llm");
const webllmPkg = JSON.parse(readFileSync(join(webllmDir, "package.json"), "utf-8")) as {
  version: string;
};
if (webllmPkg.version !== PINNED_WEBLLM_VERSION) {
  throw new Error(
    `report-data: @mlc-ai/web-llm is ${webllmPkg.version}, report cites ${PINNED_WEBLLM_VERSION} — re-derive or repin`,
  );
}
const webllmSrc = readFileSync(join(webllmDir, "lib/index.js"), "utf-8");

interface PrebuiltEntry {
  modelId: string;
  vramMb: number;
  ctx: number;
}
function prebuilt(modelId: string): PrebuiltEntry {
  const i = webllmSrc.indexOf(`"${modelId}"`);
  if (i < 0) throw new Error(`report-data: ${modelId} not in prebuiltAppConfig`);
  const chunk = webllmSrc.slice(i, i + 1200);
  const vram = /vram_required_MB:\s*([\d.]+)/.exec(chunk);
  const ctx = /context_window_size:\s*(\d+)/.exec(chunk);
  if (!vram || !ctx) throw new Error(`report-data: vram/ctx not found for ${modelId}`);
  return { modelId, vramMb: Number(vram[1]), ctx: Number(ctx[1]) };
}

// --- policy table ---------------------------------------------------------------

interface PolicyRuleJson {
  rule_id: string;
  target: string;
  privacy_local_eligible: boolean;
  hw: Record<string, unknown>;
  request: Record<string, unknown>;
  rationale: string;
}
const policy = JSON.parse(
  readFileSync(join(repoRoot, "router/src/policy.v0.json"), "utf-8"),
) as { policy_version: string; default_max_tokens: number; rules: PolicyRuleJson[] };

function fmtHw(hw: Record<string, unknown>): string {
  const parts = Object.entries(hw).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(", ") : "any";
}
function fmtRequest(req: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(req)) {
    if (k === "max_est_prompt_tokens") parts.push(`est_prompt_tokens ≤ ${v}`);
    else if (k === "max_max_tokens") parts.push(`max_tokens ≤ ${v}`);
    else if (k === "stream") parts.push(`stream=${v}`);
    else parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join(", ") : "any";
}
function firstSentence(s: string): string {
  const i = s.indexOf(". ");
  return i < 0 ? s : s.slice(0, i + 1);
}

// --- blocks ---------------------------------------------------------------------

const blocks = new Map<string, string>();

// inventory (report §1)
{
  const rows = files.map((f) => {
    const ok = okRuns(f.doc.runs).length;
    const engines = [...new Set(f.doc.runs.map((r) => r.engine))].join(", ") || NA;
    const models = [...new Set(f.doc.runs.map((r) => r.model_id))].length;
    return `| \`${f.file}\` | ${f.doc.runs.length} | ${ok} | ${f.doc.runs.length - ok} | ${engines} | ${models} |`;
  });
  const total = files.reduce((n, f) => n + f.doc.runs.length, 0);
  const totalOk = files.reduce((n, f) => n + okRuns(f.doc.runs).length, 0);
  blocks.set(
    "inventory",
    [
      "| archived export | runs | ok | failed | engines | distinct models |",
      "|---|---|---|---|---|---|",
      ...rows,
      "",
      `**${total} runs** total across ${files.length} archived exports (${totalOk} successful, ${total - totalOk} failed — failures are routing data, not noise). Full per-group medians: [\`bench/results/supplier-table.md\`](../../bench/results/supplier-table.md).`,
    ].join("\n"),
  );
}

// desktop-engine-spread (report §2)
{
  const desktop = one("desktop-chrome");
  const groups = new Map<string, RunRow[]>();
  for (const r of desktop.doc.runs) {
    const key = `${r.model_id}|${r.engine}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const rows: string[] = [];
  for (const [key, rs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, engine] = key.split("|");
    const short = rs.filter((r) => r.prompt === "short");
    const long = rs.filter((r) => r.prompt === "long-context");
    const backend = [...new Set(rs.map((r) => r.backend).filter(Boolean))].join(", ") || NA;
    rows.push(
      `| ${model} | ${engine} | ${backend} | ${med(short, (r) => r.decode_tps)} | ${med(long, (r) => r.decode_tps)} | ${med(short, (r) => r.ttft_ms, 0)} | ${med(long, (r) => r.ttft_ms, 0)} |`,
    );
  }

  // spread per model family, computed not asserted. Family substrings match the
  // per-engine model_id naming (MLC / onnx-community / bartowski variants).
  const spreadLines: string[] = [];
  for (const family of ["Llama-3.2-1B", "Qwen2.5-1.5B"]) {
    const fam = [...groups.entries()].filter(([k]) => k.includes(family));
    if (fam.length === 0) throw new Error(`report-data: no desktop groups for ${family}`);
    const decs = fam
      .map(([k, rs]) => ({
        engine: k.split("|")[1],
        dec: medNum(rs.filter((r) => r.prompt === "short"), (r) => r.decode_tps),
      }))
      .sort((a, b) => a.dec - b.dec);
    const lo = decs[0]!;
    const hi = decs[decs.length - 1]!;
    spreadLines.push(
      `- **${family}**, short prompt, identical hardware: fastest engine (${hi.engine}, ${round(hi.dec, 1)} tps) vs slowest (${lo.engine}, ${round(lo.dec, 1)} tps) = **${round(hi.dec / lo.dec, 1)}× spread**.`,
    );
  }
  blocks.set(
    "desktop-engine-spread",
    [
      `Device: \`${desktop.file}\` — ${[...new Set(desktop.doc.runs.map((r) => r.engine))].length} engines × 2 models, WebGPU desktop (adapter: ${desktop.doc.device.adapter?.vendor ?? NA} ${desktop.doc.device.adapter?.architecture ?? NA}).`,
      "",
      "| model | engine | backend | decode tps (short, med) | decode tps (long, med) | ttft ms (short, med) | ttft ms (long, med) |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
      ...spreadLines,
    ].join("\n"),
  );
}

// pixel-8a-prefill (report §3)
{
  const pixel = one("pixel-8a");
  const rows: string[] = [];
  for (const prompt of ["short", "long-context"] as const) {
    const rs = pixel.doc.runs.filter((r) => r.prompt === prompt);
    rows.push(
      `| ${prompt} | ${med(rs, (r) => r.tokens_in, 0)} | ${med(rs, (r) => r.prefill_tps)} | ${med(rs, (r) => r.decode_tps)} | ${med(rs, (r) => r.ttft_ms, 0)} | ${round(medNum(rs, (r) => r.ttft_ms) / 1000, 1)} s |`,
    );
  }
  const long = pixel.doc.runs.filter((r) => r.prompt === "long-context");
  const adapter = pixel.doc.device.adapter;
  blocks.set(
    "pixel-8a-prefill",
    [
      `Device: \`${pixel.file}\` — Pixel 8a, adapter ${adapter?.vendor ?? NA}/${adapter?.architecture ?? NA} (Mali), WebLLM ${[...new Set(pixel.doc.runs.map((r) => r.model_id))].join(", ")}.`,
      "",
      "| prompt | tokens_in (med) | prefill tps (med) | decode tps (med) | ttft ms (med) | ttft |",
      "|---|---|---|---|---|---|",
      ...rows,
      "",
      `At a median ${med(long, (r) => r.tokens_in, 0)}-token prompt, prefill at ${med(long, (r) => r.prefill_tps)} tps puts time-to-first-token at **${round(medNum(long, (r) => r.ttft_ms) / 1000, 1)} seconds**. Decode alone (${med(long, (r) => r.decode_tps)} tps) looks usable; the prefill rate is what makes long context non-viable on this GPU class.`,
    ].join("\n"),
  );
}

// iphone-kill-ladder (report §4)
{
  const attempts = byDevice("iphone-11-pro-max");
  if (attempts.length === 0) throw new Error("report-data: no iphone files");
  const rows: string[] = [];
  for (const f of attempts) {
    for (const r of f.doc.runs) {
      const err = r.error;
      rows.push(
        `| ${f.stamp} | ${r.engine} | ${r.model_id} | ${r.kv_context_window ?? NA} | ${err ? err.stage : "ok"} | ${err ? `${err.error_name}` : NA} |`,
      );
    }
  }
  const bufs = [...new Set(attempts.map((f) => f.doc.device.adapter?.maxBufferSize ?? 0))];
  if (bufs.length !== 1) throw new Error("report-data: inconsistent iPhone maxBufferSize");
  const buf = bufs[0]!;
  const totalRuns = attempts.reduce((n, f) => n + f.doc.runs.length, 0);
  const okCount = attempts.reduce((n, f) => n + okRuns(f.doc.runs).length, 0);
  blocks.set(
    "iphone-kill-ladder",
    [
      `Device: iPhone 11 Pro Max (Safari), ${attempts.length} archived attempts, **${okCount}/${totalRuns} successful runs**. Adapter \`maxBufferSize\` = ${buf} bytes ≈ **${round(buf / 1e6, 1)} MB** — the per-buffer ceiling WebKit grants this device.`,
      "",
      "| attempt | engine | model | kv ctx in effect | failed stage | error |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n"),
  );
}

// webllm-vram (report §4, pinned engine config)
{
  const entries = [
    prebuilt("Qwen2.5-0.5B-Instruct-q4f16_1-MLC"),
    prebuilt("Llama-3.2-1B-Instruct-q4f16_1-MLC"),
    prebuilt("Qwen2.5-1.5B-Instruct-q4f16_1-MLC"),
  ];
  const rows = entries.map((e) => `| ${e.modelId} | ${e.vramMb} | ${e.ctx} |`);
  const q05 = entries[0]!;
  const l1 = entries[1]!;
  const paradox =
    q05.vramMb > l1.vramMb
      ? `Note the inversion: the 0.5B Qwen (${q05.vramMb} MB) declares **more** VRAM than the 1B Llama (${l1.vramMb} MB) — vocabulary size, not parameter count, dominates at this scale. Model "size" is not a reliable proxy for memory pressure.`
      : "";
  blocks.set(
    "webllm-vram",
    [
      `Source: \`@mlc-ai/web-llm@${PINNED_WEBLLM_VERSION}\` \`prebuiltAppConfig\` (pinned; engine self-declared requirements, not measurements).`,
      "",
      "| model | vram_required_MB | context_window_size |",
      "|---|---|---|",
      ...rows,
      "",
      paradox,
    ].join("\n"),
  );
}

// iab-probe (report §5)
{
  const iab = one("pixel-8a-line-iab");
  const d = iab.doc.device;
  blocks.set(
    "iab-probe",
    [
      `Archived export: \`${iab.file}\` — **${iab.doc.runs.length} completed runs** (the session stalled mid-download and never finished; the empty \`runs\` array *is* the finding).`,
      "",
      "| probe field | value |",
      "|---|---|",
      `| webgpu | ${d.webgpu} |`,
      `| adapter.vendor / architecture | ${d.adapter?.vendor ?? NA} / ${d.adapter?.architecture ?? NA} |`,
      `| adapter.f16 | ${d.adapter?.f16 ?? NA} |`,
      `| adapter.maxBufferSize | ${d.adapter?.maxBufferSize ?? NA} |`,
      `| hw_concurrency | ${d.hw_concurrency} |`,
      `| device_memory_gb | ${d.device_memory_gb ?? NA} |`,
      "",
      `Operator note from the export: “${iab.doc.operator_notes}”`,
    ].join("\n"),
  );
}

// policy-table (README §4 / report §6)
{
  const rows = policy.rules.map(
    (r) =>
      `| ${r.rule_id} | ${r.target} | ${fmtHw(r.hw)} | ${fmtRequest(r.request)} | ${r.privacy_local_eligible ? "yes" : "no"} | ${firstSentence(r.rationale)} |`,
  );
  blocks.set(
    "policy-table",
    [
      // Absolute URL: this block is injected into both README.md (repo root)
      // and docs/report/ — a relative link cannot be correct in both places.
      `Policy \`${policy.policy_version}\` (default max_tokens ${policy.default_max_tokens}). Rules evaluate top-down; first hardware+request match wins. Full rationales live in [\`router/src/policy.v0.json\`](https://github.com/Ludion-ai/Ludion/blob/main/router/src/policy.v0.json).`,
      "",
      "| rule | target | hardware condition | request condition | privacy-eligible | rationale (first sentence) |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n"),
  );
}

// readme-evidence (README §5)
{
  const total = files.reduce((n, f) => n + f.doc.runs.length, 0);
  const devices = [...new Set(files.map((f) => f.device))];
  blocks.set(
    "readme-evidence",
    `Policy v0 is derived from **${total} archived benchmark runs** across **${devices.length} device/environment configurations** (${devices.join(", ")}), collected with [\`bench/\`](bench/) and archived byte-for-byte in [\`bench/results/\`](bench/results/). The aggregate is regenerated by script — no number in this README or the report is hand-typed.`,
  );
}

// --- inject ---------------------------------------------------------------------

const MARKER_RE = /<!-- gen:([a-z0-9-]+) -->[\s\S]*?<!-- \/gen:\1 -->/g;
const used = new Set<string>();

for (const target of TARGET_FILES) {
  const before = readFileSync(target, "utf-8");
  const after = before.replace(MARKER_RE, (_m, name: string) => {
    const body = blocks.get(name);
    if (body === undefined) throw new Error(`report-data: ${target} references unknown block "${name}"`);
    used.add(name);
    return `<!-- gen:${name} -->\n${body}\n<!-- /gen:${name} -->`;
  });
  if (after !== before) writeFileSync(target, after);
  console.log(`report-data: ${target} ${after !== before ? "updated" : "unchanged"}`);
}

for (const name of blocks.keys()) {
  if (!used.has(name)) throw new Error(`report-data: block "${name}" defined but no target uses it`);
}
console.log(`report-data: OK (${blocks.size} blocks, ${files.length} result files)`);
