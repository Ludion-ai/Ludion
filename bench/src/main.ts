import "./style.css";
import { probeDevice } from "./capability";
import { createBrowserStore, type PersistedState } from "./state";
import { runSession } from "./harness";
import { getModel, type ModelKey } from "./models";
import { buildDocument, copyToClipboard, downloadJson, wipeOriginStorage } from "./export";
import { median, round } from "./metrics";
import type { BenchAdapter } from "./adapters/types";
import { createWebLLMAdapter } from "./adapters/webllm";
import { createTransformersJsAdapter } from "./adapters/transformersjs";
import { createWllamaAdapter } from "./adapters/wllama";
import type { CacheState, DeviceInfo, EngineId, RunRow } from "./schema";

const ADAPTERS: Record<EngineId, () => BenchAdapter> = {
  webllm: createWebLLMAdapter,
  transformersjs: createTransformersJsAdapter,
  wllama: createWllamaAdapter,
};

const AUTORUN_KEY = "ludion.bench.autorun";

const store = createBrowserStore();
let state: PersistedState | null = store.loadState();
let device: DeviceInfo | null = null;
let running = false;

// --- DOM ---------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const ui = {
  banner: () => el<HTMLDivElement>("resume-banner"),
  capability: () => el<HTMLDListElement>("capability"),
  label: () => el<HTMLInputElement>("device-label"),
  notes: () => el<HTMLTextAreaElement>("notes"),
  autoChain: () => el<HTMLInputElement>("auto-chain"),
  progress: () => el<HTMLDivElement>("progress"),
  log: () => el<HTMLPreElement>("log"),
  results: () => el<HTMLTableElement>("results"),
  summary: () => el<HTMLTableElement>("summary"),
  runCold: () => el<HTMLButtonElement>("run-cold"),
  runWarm: () => el<HTMLButtonElement>("run-warm"),
  resetPlan: () => el<HTMLButtonElement>("reset-plan"),
};

function log(msg: string): void {
  const node = ui.log();
  node.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  node.scrollTop = node.scrollHeight;
}

function showProgress(text: string, loaded: number | null, total: number | null): void {
  const pct = loaded !== null && total !== null && total > 0 ? (loaded / total) * 100 : null;
  const bytes =
    loaded !== null && total !== null && total > 0
      ? ` ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (${pct!.toFixed(1)}%)`
      : "";
  ui.progress().innerHTML = "";
  const line = document.createElement("div");
  line.textContent = `${text}${bytes}`;
  ui.progress().appendChild(line);
  if (pct !== null) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
    bar.appendChild(fill);
    ui.progress().appendChild(bar);
  }
}

// --- rendering -----------------------------------------------------------

const RUN_COLS = [
  "engine", "backend", "model", "prompt", "cache",
  "dl ms", "dl MB", "init ms", "ttft ms", "prefill tps", "decode tps",
  "tok in", "tok out", "mem MB", "error",
] as const;

function fmt(v: number | string | null): string {
  return v === null ? "—" : String(v);
}

function renderResults(): void {
  const runs = state?.runs ?? [];
  const table = ui.results();
  table.innerHTML = "";
  const head = table.insertRow();
  for (const c of RUN_COLS) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  for (const r of runs) {
    const row = table.insertRow();
    if (r.error) row.className = "error-row";
    const cells: (string | number | null)[] = [
      r.engine, r.backend, r.model_id.split("/").pop() ?? r.model_id, r.prompt, r.cache_state,
      r.download_ms, r.download_mb, r.init_ms, r.ttft_ms, r.prefill_tps, r.decode_tps,
      r.tokens_in, r.tokens_out, r.peak_mem_mb,
      r.error ? `${r.error.stage}: ${r.error.error_name}` : null,
    ];
    cells.forEach((v, i) => {
      const td = row.insertCell();
      td.textContent = fmt(v);
      if (i <= 4 || i === cells.length - 1) td.className = "l";
    });
  }
  renderSummary(runs);
}

function renderSummary(runs: RunRow[]): void {
  const table = ui.summary();
  table.innerHTML = "";
  const head = table.insertRow();
  for (const c of ["engine", "backend", "model", "prompt", "cache", "runs", "med ttft", "med prefill", "med decode"]) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.error) continue;
    const key = `${r.engine}|${r.backend}|${r.model_id}|${r.prompt}|${r.cache_state}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const [key, rows] of groups) {
    const [engine, backend, modelId, prompt, cache] = key.split("|");
    const tr = table.insertRow();
    const meds = [
      median(rows.map((r) => r.ttft_ms).filter((v): v is number => v !== null)),
      median(rows.map((r) => r.prefill_tps).filter((v): v is number => v !== null)),
      median(rows.map((r) => r.decode_tps).filter((v): v is number => v !== null)),
    ].map((m) => round(m, 1));
    const cells = [engine, backend, modelId!.split("/").pop(), prompt, cache, String(rows.length), ...meds.map(fmt)];
    cells.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v ?? "—";
      if (i <= 4) td.className = "l";
    });
  }
}

function renderCapability(d: DeviceInfo): void {
  const dl = ui.capability();
  dl.innerHTML = "";
  const entries: [string, string][] = [
    ["WebGPU", d.webgpu ? "yes" : "no"],
    ["Adapter", d.adapter ? `${d.adapter.vendor} ${d.adapter.architecture}`.trim() || "(unnamed)" : "—"],
    ["shader-f16", d.adapter ? String(d.adapter.f16) : "—"],
    ["maxBufferSize", d.adapter ? `${(d.adapter.maxBufferSize / 1e6).toFixed(0)} MB` : "—"],
    ["Cores", String(d.hw_concurrency)],
    ["deviceMemory", d.device_memory_gb !== null ? `${d.device_memory_gb} GB` : "n/a (gated)"],
    ["Screen", d.screen],
    ["crossOriginIsolated", String(typeof crossOriginIsolated !== "undefined" && crossOriginIsolated)],
    ["UA", d.ua],
  ];
  for (const [k, v] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function describeItem(item: { engine: EngineId; modelKey: ModelKey; cacheState: CacheState }): string {
  return `${item.engine} / ${getModel(item.modelKey).label} / ${item.cacheState}`;
}

function updateBanner(): void {
  const banner = ui.banner();
  const next = state ? store.nextPending(state) : null;
  if (!next || running) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  banner.innerHTML = "";
  banner.append(`Next session: ${describeItem(next)}`);
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Continue (one tap)";
  btn.onclick = () => {
    void startNext();
  };
  banner.appendChild(btn);
}

function setRunning(value: boolean): void {
  running = value;
  ui.runCold().disabled = value;
  ui.runWarm().disabled = value;
  ui.resetPlan().disabled = value;
  updateBanner();
}

// --- run flow --------------------------------------------------------------

async function startNext(): Promise<void> {
  if (!state || running) return;
  const item = store.nextPending(state);
  if (!item) {
    log("queue empty — all sessions finished. Export the JSON.");
    updateBanner();
    return;
  }
  setRunning(true);
  const adapter = ADAPTERS[item.engine]();
  const spec = getModel(item.modelKey);
  log(`starting: ${describeItem(item)} (engine v${adapter.version()})`);
  try {
    await runSession(store, state, item, adapter, spec, {
      log,
      onProgress: (p) => showProgress(`[${item.engine}] ${p.kind}: ${p.text}`, p.loadedBytes, p.totalBytes),
      onRow: () => renderResults(),
    });
  } catch (e) {
    // runSession records its own error rows; this catch is a last-resort guard
    // so one engine can never take down the page (spec Section 5).
    log(`session crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
    store.markSession(state, item, "aborted");
  }
  showProgress("idle", null, null);
  renderResults();
  setRunning(false);

  const next = store.nextPending(state);
  if (next) {
    // Reload between engine sessions is the one architecture (spec review A-3).
    if (ui.autoChain().checked) {
      sessionStorage.setItem(AUTORUN_KEY, "1");
      log(`reloading for next session: ${describeItem(next)}`);
      setTimeout(() => location.reload(), 400);
    } else {
      log(`next session ready: ${describeItem(next)} — reload to continue.`);
      const banner = ui.banner();
      banner.classList.remove("hidden");
      banner.innerHTML = "";
      banner.append(`Next session: ${describeItem(next)}`);
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "Reload & continue (one tap)";
      btn.onclick = () => {
        sessionStorage.setItem(AUTORUN_KEY, "1");
        location.reload();
      };
      banner.appendChild(btn);
    }
  } else {
    log("all sessions finished. Export the JSON.");
  }
}

function modelOrder(): ModelKey[] {
  const value =
    (document.querySelector('input[name="model-order"]:checked') as HTMLInputElement | null)
      ?.value ?? "qwen-first";
  switch (value) {
    case "llama-first":
      return ["llama-3.2-1b", "qwen2.5-1.5b"];
    case "qwen-only":
      return ["qwen2.5-1.5b"];
    case "llama-only":
      return ["llama-3.2-1b"];
    case "qwen-0.5b-only":
      return ["qwen2.5-0.5b"];
    default:
      return ["qwen2.5-1.5b", "llama-3.2-1b"];
  }
}

function selectedEngines(): EngineId[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('#engine-list input[type="checkbox"]:checked'),
  ).map((i) => i.value as EngineId);
}

async function enqueueAndRun(cacheState: CacheState): Promise<void> {
  const engines = selectedEngines();
  if (engines.length === 0) {
    log("no engines selected");
    return;
  }
  if (!state) state = store.newState(ui.label().value);
  state.operatorLabel = ui.label().value;
  if (cacheState === "cold") {
    log("wiping origin storage for cold run…");
    await wipeOriginStorage(log);
  }
  store.enqueue(state, engines, modelOrder(), cacheState);
  log(`enqueued ${engines.length * modelOrder().length} session(s), cache_state=${cacheState}`);
  await startNext();
}

// --- boot --------------------------------------------------------------

async function boot(): Promise<void> {
  if (state) {
    ui.label().value = state.operatorLabel;
    ui.notes().value = state.operatorNotes;
    const recovered = store.recoverTombstone(state);
    for (const row of recovered) {
      log(
        `tombstone recovered (${row.error?.stage}): ${row.engine}/${row.prompt} marked as ${row.error?.error_name} — the tab kill is now data.`,
      );
    }
    renderResults();
  }

  ui.label().addEventListener("change", () => {
    if (state) {
      state.operatorLabel = ui.label().value;
      store.saveState(state);
    }
  });
  ui.notes().addEventListener("change", () => {
    if (!state) state = store.newState(ui.label().value);
    state.operatorNotes = ui.notes().value;
    store.saveState(state);
  });
  ui.runCold().addEventListener("click", () => void enqueueAndRun("cold"));
  ui.runWarm().addEventListener("click", () => void enqueueAndRun("warm"));
  ui.resetPlan().addEventListener("click", () => {
    if (confirm("Discard the plan AND all collected results?")) {
      store.clearState();
      location.reload();
    }
  });
  el<HTMLButtonElement>("copy-json").addEventListener("click", () => {
    void (async () => {
      if (!device) return;
      await copyToClipboard(buildDocument(state ?? store.newState(ui.label().value), device));
      log("copied JSON to clipboard");
    })();
  });
  el<HTMLButtonElement>("download-json").addEventListener("click", () => {
    if (!device) return;
    downloadJson(buildDocument(state ?? store.newState(ui.label().value), device));
  });
  el<HTMLButtonElement>("wipe-storage").addEventListener("click", () => {
    void wipeOriginStorage(log);
  });

  device = await probeDevice(ui.label().value);
  renderCapability(device);

  const autorun = sessionStorage.getItem(AUTORUN_KEY) === "1";
  sessionStorage.removeItem(AUTORUN_KEY);
  if (autorun && state && store.nextPending(state)) {
    void startNext();
  } else {
    updateBanner();
  }
}

void boot();
