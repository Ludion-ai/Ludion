import type { BenchAdapter, DownloadProgress } from "./adapters/types";
import type { BenchError, CacheState, MetricSource, RunRow } from "./schema";
import type { ModelSpec } from "./models";
import { PROMPTS, TIMED_RUNS, WARMUP_RUNS } from "./prompts";
import { decodeTps, prefillTps, round } from "./metrics";
import type { BenchStore, PersistedState, SessionPlanItem } from "./state";

/**
 * Shared measurement harness (spec Section 7): ALL timing lives here, on one
 * clock (performance.now), one code path. Adapters only surface engine events.
 */

export interface HarnessHooks {
  log: (msg: string) => void;
  onProgress: (p: DownloadProgress) => void;
  /** Called after every persisted run row so the UI can re-render. */
  onRow: (row: RunRow) => void;
}

function toBenchError(stage: BenchError["stage"], e: unknown): BenchError {
  if (e instanceof Error) {
    return { stage, error_name: e.name || "Error", error_message: e.message };
  }
  return { stage, error_name: "UnknownError", error_message: String(e) };
}

function emptyRow(
  adapter: BenchAdapter,
  spec: ModelSpec,
  prompt: (typeof PROMPTS)[number],
  cacheState: CacheState,
): RunRow {
  const ref = spec.engines[adapter.id];
  return {
    engine: adapter.id,
    engine_version: adapter.version(),
    backend: null,
    model_id: ref.modelId,
    quant: ref.quant,
    prompt: prompt.id,
    cache_state: cacheState,
    download_ms: null,
    download_mb: null,
    init_ms: null,
    ttft_ms: null,
    prefill_tps: null,
    decode_tps: null,
    tokens_in: null,
    tokens_out: null,
    token_count_source: null,
    timing_source: null,
    peak_mem_mb: null,
    error: null,
  };
}

/** Best-effort JS heap sampler; performance.memory is Chrome-only (gated). */
class MemSampler {
  private peak = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private available =
    typeof performance !== "undefined" &&
    typeof (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ===
      "number";

  start(): void {
    if (!this.available) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), 250);
  }

  private sample(): void {
    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) this.peak = Math.max(this.peak, mem.usedJSHeapSize);
  }

  stop(): number | null {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.available) return null;
    this.sample();
    return round(this.peak / (1024 * 1024), 1);
  }
}

async function batteryLevel(): Promise<number | null> {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
  if (typeof nav.getBattery !== "function") return null;
  try {
    return (await nav.getBattery()).level;
  } catch {
    return null;
  }
}

export async function runSession(
  store: BenchStore,
  state: PersistedState,
  item: SessionPlanItem,
  adapter: BenchAdapter,
  spec: ModelSpec,
  hooks: HarnessHooks,
): Promise<void> {
  const ref = spec.engines[adapter.id];
  const session = {
    engine: adapter.id,
    model_id: ref.modelId,
    cache_state: item.cacheState,
    started_at: new Date().toISOString(),
    ended_at: null as string | null,
    battery_start: await batteryLevel(),
    battery_end: null as number | null,
  };
  store.appendSession(state, session);
  hooks.log(`session start: ${adapter.id} / ${spec.key} / ${item.cacheState}`);

  // ---- load (download + init) --------------------------------------------
  const tLoadStart = performance.now();
  let lastDownloadEventAt: number | null = null;
  let sawIncompleteDownload = false;
  let maxLoadedBytes = 0;
  let maxTotalBytes = 0;
  let maxApproxMb = 0;

  let loadInfo: Awaited<ReturnType<BenchAdapter["load"]>> | null = null;
  let loadError: BenchError | null = null;
  try {
    loadInfo = await adapter.load(ref, (p) => {
      if (p.kind === "download") {
        lastDownloadEventAt = performance.now();
        if (p.loadedBytes !== null) maxLoadedBytes = Math.max(maxLoadedBytes, p.loadedBytes);
        if (p.totalBytes !== null) maxTotalBytes = Math.max(maxTotalBytes, p.totalBytes);
        if (p.approxMb !== null) maxApproxMb = Math.max(maxApproxMb, p.approxMb);
        sawIncompleteDownload =
          p.totalBytes !== null && p.loadedBytes !== null && p.loadedBytes < p.totalBytes;
      } else {
        sawIncompleteDownload = false;
      }
      hooks.onProgress(p);
    });
  } catch (e) {
    // Heuristic: if the failure happened while byte download was still
    // incomplete, it's a download failure; otherwise init.
    loadError = toBenchError(sawIncompleteDownload ? "download" : "init", e);
    hooks.log(`load failed (${loadError.stage}): ${loadError.error_message}`);
  }
  const tReady = performance.now();

  const downloadMs =
    lastDownloadEventAt !== null ? round(lastDownloadEventAt - tLoadStart, 0) : null;
  const initMs =
    loadError === null ? round(tReady - (lastDownloadEventAt ?? tLoadStart), 0) : null;
  const downloadMb =
    maxTotalBytes > 0
      ? round(maxTotalBytes / (1024 * 1024), 1)
      : maxLoadedBytes > 0
        ? round(maxLoadedBytes / (1024 * 1024), 1)
        : maxApproxMb > 0
          ? maxApproxMb
          : null;

  if (loadError) {
    // One error row per prompt so the failure is visible in every summary cell.
    for (const prompt of PROMPTS) {
      const row = emptyRow(adapter, spec, prompt, item.cacheState);
      row.download_ms = downloadMs;
      row.download_mb = downloadMb;
      row.error = loadError;
      store.appendRun(state, row);
      hooks.onRow(row);
    }
    session.battery_end = await batteryLevel();
    session.ended_at = new Date().toISOString();
    store.markSession(state, item, "aborted");
    store.saveState(state);
    return;
  }

  const backend = loadInfo!.backend;
  const timingSource: MetricSource = loadInfo!.timingSource;
  hooks.log(
    `ready: backend=${backend} download_ms=${downloadMs ?? "n/a"} init_ms=${initMs ?? "n/a"} download_mb=${downloadMb ?? "n/a"}`,
  );

  // ---- generations ---------------------------------------------------------
  for (const prompt of PROMPTS) {
    let promptFailed = false;
    for (let i = 0; i < WARMUP_RUNS + TIMED_RUNS && !promptFailed; i++) {
      const isWarmup = i < WARMUP_RUNS;
      const label = isWarmup ? "warmup" : `timed ${i - WARMUP_RUNS + 1}/${TIMED_RUNS}`;
      hooks.log(`${adapter.id} / ${prompt.id}: ${label}`);

      // Tombstone (operator requirement ii): written before generate, cleared
      // on completion. Survives an OOM tab kill and becomes an error row.
      store.writeTombstone({
        engine: adapter.id,
        engineVersion: adapter.version(),
        backend,
        modelKey: spec.key,
        modelId: ref.modelId,
        quant: ref.quant,
        prompt: prompt.id,
        cacheState: item.cacheState,
        startedAt: new Date().toISOString(),
      });

      const mem = new MemSampler();
      mem.start();
      const tStart = performance.now();
      let tFirst: number | null = null;
      let tLast: number | null = null;
      let tokenEvents = 0;
      try {
        const result = await adapter.generate(
          { prompt: prompt.text, maxTokens: prompt.maxTokens },
          () => {
            const now = performance.now();
            if (tFirst === null) tFirst = now;
            tLast = now;
            tokenEvents++;
          },
        );
        store.clearTombstone();
        const peakMb = mem.stop();
        if (isWarmup) continue;

        const ttft = tFirst !== null ? (tFirst as number) - tStart : null;
        const tokensIn = result.tokensIn;
        const tokensOut = result.tokensOut ?? (tokenEvents > 0 ? tokenEvents : null);
        const tokenSource: MetricSource =
          result.tokensIn !== null && result.tokensOut !== null
            ? result.tokenCountSource
            : "estimated";

        const row = emptyRow(adapter, spec, prompt, item.cacheState);
        row.backend = backend;
        row.download_ms = downloadMs;
        row.download_mb = downloadMb;
        row.init_ms = initMs;
        row.ttft_ms = round(ttft, 0);
        row.prefill_tps = round(prefillTps(tokensIn, ttft));
        row.decode_tps = round(decodeTps(tokensOut, tFirst, tLast));
        row.tokens_in = tokensIn;
        row.tokens_out = tokensOut;
        row.token_count_source = tokenSource;
        row.timing_source = timingSource;
        row.peak_mem_mb = peakMb;
        store.appendRun(state, row);
        hooks.onRow(row);
        if (result.engineReported) {
          hooks.log(
            `  engine-reported: prefill=${result.engineReported.prefillTps?.toFixed(1) ?? "n/a"} tps, decode=${result.engineReported.decodeTps?.toFixed(1) ?? "n/a"} tps`,
          );
        }
      } catch (e) {
        store.clearTombstone();
        mem.stop();
        const row = emptyRow(adapter, spec, prompt, item.cacheState);
        row.backend = backend;
        row.download_ms = downloadMs;
        row.download_mb = downloadMb;
        row.init_ms = initMs;
        row.error = toBenchError("generate", e);
        store.appendRun(state, row);
        hooks.onRow(row);
        hooks.log(`generate failed: ${row.error.error_message}`);
        promptFailed = true; // skip remaining runs for this prompt, keep next prompt
      }
    }
  }

  // ---- teardown ------------------------------------------------------------
  try {
    await adapter.unload();
  } catch (e) {
    hooks.log(`unload residue (${adapter.id}): ${e instanceof Error ? e.message : String(e)}`);
  }
  session.battery_end = await batteryLevel();
  session.ended_at = new Date().toISOString();
  store.markSession(state, item, "done");
  store.saveState(state);
  hooks.log(`session done: ${adapter.id} / ${spec.key} / ${item.cacheState}`);
}
