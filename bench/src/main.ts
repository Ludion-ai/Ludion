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
import { autoPlan, guessLabel } from "./plan";
import { collectorUrl, submitResult } from "./submit";
import { buildComparison } from "./compare";
import { contentHash, createBrowserSubmittedStore } from "./submitted";

const ADAPTERS: Record<EngineId, () => BenchAdapter> = {
  webllm: createWebLLMAdapter,
  transformersjs: createTransformersJsAdapter,
  wllama: createWllamaAdapter,
};

const AUTORUN_KEY = "ludion.bench.autorun";
const ADVANCED_KEY = "ludion.bench.advanced.v1"; // Gate 5 (OQ3): persist fold state.

const store = createBrowserStore();
const submittedStore = createBrowserSubmittedStore(); // Gate 5 §1: submit-once.
let state: PersistedState | null = store.loadState();
let device: DeviceInfo | null = null;
let running = false;
let compareShown = false; // Gate 4 ①: fetch the crowd aggregate at most once per page.
let completionScrolled = false; // Gate 5 (B-6): scroll completion into view once per page.
let submitStateToken = 0; // guards the async refreshSubmitState against stale writes.

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
  // Gate 2.7 one-click flow
  verdict: () => el<HTMLParagraphElement>("probe-verdict"),
  planNote: () => el<HTMLParagraphElement>("plan-note"),
  measure: () => el<HTMLButtonElement>("measure"),
  completion: () => el<HTMLElement>("completion"),
  completionHeadline: () => el<HTMLHeadingElement>("completion-headline"),
  compareLine: () => el<HTMLParagraphElement>("compare-line"),
  counter: () => el<HTMLParagraphElement>("device-counter"),
  submitBtn: () => el<HTMLButtonElement>("submit-result"),
  submitNote: () => el<HTMLParagraphElement>("submit-note"),
  dataCtaWrap: () => el<HTMLParagraphElement>("data-cta-wrap"),
  runStatus: () => el<HTMLParagraphElement>("run-status"),
  runDone: () => el<HTMLDivElement>("run-done"),
  advanced: () => el<HTMLDetailsElement>("advanced"),
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

// --- Gate 5: honest run progress (kills the silent valley) -----------------

const promptLabel = (id: RunRow["prompt"]): string =>
  id === "short" ? "short prompt" : "long prompt";

/** One-liner shown the moment a run starts — covers the download/init valley. */
function setRunExpectation(): void {
  ui.runStatus().textContent =
    "Starting… this runs 2 prompts × 3 timed runs. On older phones the long prompt can take a minute.";
  ui.runStatus().classList.remove("hidden");
}

/** Live "Running k of N — <prompt>" / "Warming up" from the harness hook. */
function showRunStatus(info: {
  prompt: RunRow["prompt"];
  isWarmup: boolean;
  timedIndex: number;
  timedTotal: number;
  promptIndex: number;
  promptTotal: number;
}): void {
  if (info.isWarmup) {
    ui.runStatus().textContent = `Warming up — ${promptLabel(info.prompt)}…`;
  } else {
    const k = info.promptIndex * info.timedTotal + info.timedIndex;
    const n = info.promptTotal * info.timedTotal;
    ui.runStatus().textContent = `Running ${k} of ${n} — ${promptLabel(info.prompt)}`;
  }
  ui.runStatus().classList.remove("hidden");
}

/** Compact landed-result chip per timed row (success or failure). */
function addRunDoneChip(row: RunRow): void {
  const chip = document.createElement("span");
  chip.className = "chip";
  const label = row.prompt === "short" ? "short" : "long";
  if (row.error) {
    chip.classList.add("fail");
    chip.textContent = `${label} ✗`;
  } else {
    chip.textContent = `${label} ✓ ~${row.decode_tps ?? "?"} tok/s`;
  }
  ui.runDone().appendChild(chip);
}

/** New measurement batch: clear live progress and the prior submitted/CTA UI. */
function resetRunProgressUI(): void {
  ui.runDone().innerHTML = "";
  ui.runStatus().classList.add("hidden");
  ui.runStatus().textContent = "";
  ui.dataCtaWrap().classList.add("hidden");
  completionScrolled = false;
}

function revealDataCta(): void {
  ui.dataCtaWrap().classList.remove("hidden");
}

/**
 * Gate 5 §1 (B-4): settle the Submit affordance from the content-hash store.
 * If this exact measurement was already submitted (this session OR a prior one,
 * surviving reload), the button is disabled + confirmed and the /data link is
 * shown; otherwise it is live. The async hash is guarded by a token so a stale
 * resolution can never clobber a newer state.
 */
async function refreshSubmitState(): Promise<void> {
  if (!device || !state) return;
  const token = ++submitStateToken;
  const doc = buildDocument(state, device);
  const hash = await contentHash(doc);
  if (token !== submitStateToken) return; // superseded by a newer refresh
  const btn = ui.submitBtn();
  if (submittedStore.has(hash)) {
    btn.disabled = true;
    btn.textContent = "✓ Submitted — thank you";
    btn.classList.remove("primary");
    ui.completionHeadline().textContent = "✓ Submitted — thank you";
    revealDataCta();
  } else {
    btn.disabled = false;
    btn.textContent = "Submit result";
    btn.classList.add("primary");
    ui.completionHeadline().textContent = "✓ Done — submit your result?";
  }
}

/** Scroll the completion card into view once, after layout settles (B-6). */
function scrollCompletionIntoView(): void {
  if (completionScrolled) return;
  completionScrolled = true;
  requestAnimationFrame(() => {
    ui.completion().scrollIntoView({ behavior: "smooth", block: "start" });
  });
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
  ui.measure().disabled = value;
  updateBanner();
  renderFlow();
}

// --- Gate 2.7 one-click flow ----------------------------------------------

function renderVerdict(d: DeviceInfo): void {
  const plan = autoPlan(d);
  const spec = getModel(plan.modelKey);
  const mem = d.device_memory_gb !== null ? ` · ${d.device_memory_gb} GB reported` : "";
  ui.verdict().textContent = `${d.webgpu ? "WebGPU available" : "no WebGPU"} · ${d.hw_concurrency} cores${mem}.`;
  ui.planNote().textContent =
    `One tap runs: ${plan.engine} × ${spec.label}, cold start, 2 prompts × 3 timed runs — ` +
    `${plan.reason}. Download ≈${spec.engines[plan.engine].approxMb} MB; nothing is sent until you submit.`;
}

/**
 * Default-flow state machine (decisions F-7/F-8): the Measure button owns the
 * screen until a plan exists; the completion card owns it once nothing is
 * pending and at least one run row exists — including after tombstone
 * recovery, so a device that died mid-bench still reaches Submit.
 */
function renderFlow(): void {
  const pending = state ? store.nextPending(state) : null;
  const hasPlan = state !== null && state.queue.length > 0;
  ui.measure().classList.toggle("hidden", running || hasPlan);

  const complete = !running && state !== null && pending === null && state.runs.length > 0;
  ui.completion().classList.toggle("hidden", !complete);
  // Completion owns the screen; the live run-status line is no longer relevant.
  if (complete) ui.runStatus().classList.add("hidden");
  if (!complete) return;

  // Freeze collected_at once, at completion, BEFORE any hashing (decisions B-2):
  // a stable timestamp makes the submitted bytes — and the content hash — equal
  // across re-press and reload, so client persistence and Worker dedupe agree.
  if (state && !state.collectedAt) {
    state.collectedAt = new Date().toISOString();
    store.saveState(state);
  }

  // Gate 4 ①: one-line crowd comparison. Best-effort and fired once — if the
  // aggregate endpoint is down the line stays hidden, never an error (F-6).
  if (!compareShown && device && state) {
    compareShown = true;
    const runs = state.runs;
    void buildComparison(device, runs).then((line) => {
      if (line !== null) {
        ui.compareLine().textContent = line;
        ui.compareLine().classList.remove("hidden");
      }
    });
  }

  if (collectorUrl() === null) {
    ui.submitBtn().classList.add("hidden");
    ui.submitNote().textContent =
      "Submission opens when the collector is deployed — use Download JSON instead.";
  } else {
    ui.submitBtn().classList.remove("hidden");
    // Settle the button (live vs already-submitted) from the content hash.
    void refreshSubmitState();
  }

  if (state?.submitted) {
    ui.counter().textContent = `Device #${state.submitted.total} measured — thank you.`;
    ui.counter().classList.remove("hidden");
  } else {
    ui.counter().classList.add("hidden");
  }

  scrollCompletionIntoView();
}

async function measureAndRun(): Promise<void> {
  if (running || !device) return;
  const plan = autoPlan(device);
  if (!state) state = store.newState(ui.label().value);
  state.operatorLabel = ui.label().value;
  // New measurement = new collected_at stamp + fresh progress UI (decisions B-2).
  state.collectedAt = undefined;
  resetRunProgressUI();
  log(
    `auto plan (${plan.deviceClass}): ${plan.engine} × ${getModel(plan.modelKey).label}, ` +
      `cache_state=${plan.cacheState} — ${plan.reason}`,
  );
  log("wiping origin storage for cold run…");
  await wipeOriginStorage(log);
  store.enqueue(state, [plan.engine], [plan.modelKey], plan.cacheState);
  renderFlow();
  await startNext();
}

/**
 * Gate 5 §1 (A-1/B-4): press → disable immediately (kills the double-press,
 * the real integrity goal) + "submitting…". Settle to "✓ Submitted — thank you"
 * ONLY on a confirmed ok (deduped counts), recording the content hash so the
 * settled state survives reload. On failure, re-enable with an honest error +
 * Download-JSON fallback — a failed POST must never strand the data.
 */
async function submitCurrent(): Promise<void> {
  if (!device || !state) return;
  // Ensure collected_at is frozen so the hash we persist == the bytes we POST
  // == the Worker's dedupe input (defense in depth, all three agree).
  if (!state.collectedAt) {
    state.collectedAt = new Date().toISOString();
    store.saveState(state);
  }
  const doc = buildDocument(state, device);
  const hash = await contentHash(doc);

  ui.submitBtn().disabled = true;
  ui.submitNote().textContent = "submitting…";
  const res = await submitResult(doc);
  if (res.ok) {
    submittedStore.add(hash);
    state.submitted = { at: new Date().toISOString(), total: res.total_submissions };
    store.saveState(state);
    ui.submitNote().textContent = res.deduped
      ? "this result was already in the dataset — counted once."
      : "✓ Submitted — thank you.";
    log(
      res.deduped
        ? `submit: already in the dataset (device #${res.total_submissions})`
        : `submit ok: device #${res.total_submissions}`,
    );
    revealDataCta();
  } else {
    ui.submitNote().textContent = `submit failed (${res.code}): ${res.message} — your data is safe; try again or use Download JSON.`;
    log(`submit failed (${res.code}): ${res.message}`);
  }
  // refreshSubmitState (via renderFlow) is the single source of truth for the
  // button: it settles to "✓ Submitted" on success or re-enables on failure.
  renderFlow();
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
  setRunExpectation(); // cover the silent download/init valley immediately.
  const adapter = ADAPTERS[item.engine]();
  const spec = getModel(item.modelKey);
  log(`starting: ${describeItem(item)} (engine v${adapter.version()})`);
  try {
    await runSession(store, state, item, adapter, spec, {
      log,
      onProgress: (p) => showProgress(`[${item.engine}] ${p.kind}: ${p.text}`, p.loadedBytes, p.totalBytes),
      onRow: (row) => {
        renderResults();
        addRunDoneChip(row);
      },
      onRunStart: (info) => showRunStatus(info),
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
  // New measurement batch = fresh collected_at stamp + fresh progress UI.
  state.collectedAt = undefined;
  resetRunProgressUI();
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
  ui.measure().addEventListener("click", () => void measureAndRun());
  ui.submitBtn().addEventListener("click", () => void submitCurrent());

  // Gate 5 (OQ3): persist the Advanced fold so an operator opens it once and it
  // stays open across the bench's auto-reloads. The reload session flow reads
  // its inputs by element id, so the fold state never affects correctness.
  const advanced = ui.advanced();
  try {
    if (localStorage.getItem(ADVANCED_KEY) === "1") advanced.open = true;
  } catch {
    /* fold state is a convenience; ignore storage failures */
  }
  advanced.addEventListener("toggle", () => {
    try {
      localStorage.setItem(ADVANCED_KEY, advanced.open ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  device = await probeDevice(ui.label().value);
  renderCapability(device);
  renderVerdict(device);
  // Prefill the UA-derived guess (spec §1-2); an edit — or a restored
  // operator label — always wins.
  if (ui.label().value === "") {
    ui.label().value = guessLabel(device.ua);
  }

  const autorun = sessionStorage.getItem(AUTORUN_KEY) === "1";
  sessionStorage.removeItem(AUTORUN_KEY);
  if (autorun && state && store.nextPending(state)) {
    void startNext();
  } else {
    updateBanner();
    renderFlow();
  }
}

void boot();
