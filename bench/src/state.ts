import type { Backend, CacheState, EngineId, PromptId, RunRow, SessionRow } from "./schema";
import type { ModelKey } from "./models";

/**
 * Reload-flow state machine (approved at spec review as the ONE architecture
 * for all engines — WebLLM's unload() is unreliable, so every engine session
 * runs in a fresh page load and persists everything to localStorage).
 *
 * Additional requirements from the operator:
 *  (i)  auto-resume: after reload the UI reads this state and offers one-tap
 *       continuation of the next pending session (one-handed phone use);
 *  (ii) tombstone marker: written immediately before generate() and cleared on
 *       completion. A tombstone surviving a reload means the tab was killed
 *       mid-generation (iOS OOM kill) and is converted into an error row
 *       { stage: "generate", error_name: "probable_oom_tab_kill" } — the tab
 *       kill becomes data instead of silence.
 */

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STATE_KEY = "entelic.bench.state.v0";
const TOMBSTONE_KEY = "entelic.bench.tombstone.v0";

export type SessionStatus = "pending" | "done" | "aborted";

export interface SessionPlanItem {
  engine: EngineId;
  modelKey: ModelKey;
  cacheState: CacheState;
  status: SessionStatus;
}

export interface PersistedState {
  version: 1;
  operatorLabel: string;
  operatorNotes: string;
  queue: SessionPlanItem[];
  sessions: SessionRow[];
  runs: RunRow[];
}

export interface Tombstone {
  /**
   * "init": written immediately before adapter.load(), cleared at "ready".
   *         Covers tab kills during download/model init (observed on iPhone:
   *         sessions left ended_at:null with no error row, causing an infinite
   *         retry loop because only generate was tombstoned).
   * "generate": written immediately before generate(), cleared on completion.
   */
  stage: "init" | "generate";
  engine: EngineId;
  engineVersion: string;
  backend: Backend | null;
  modelKey: ModelKey;
  modelId: string;
  quant: string;
  /** null for stage "init" (no prompt in flight yet). */
  prompt: PromptId | null;
  cacheState: CacheState;
  startedAt: string;
  /**
   * KV sizing in effect, known once load resolves — null for stage "init".
   * Carried so an OOM-kill row records the measurement condition it died under.
   */
  kvContextWindow: number | null;
  prefillChunk: number | null;
}

/** All prompt ids, used to emit one error row per prompt for init-stage kills. */
const ALL_PROMPTS: readonly PromptId[] = ["short", "long-context"];

export class BenchStore {
  constructor(private kv: KV) {}

  loadState(): PersistedState | null {
    const raw = this.kv.getItem(STATE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  saveState(state: PersistedState): void {
    this.kv.setItem(STATE_KEY, JSON.stringify(state));
  }

  clearState(): void {
    this.kv.removeItem(STATE_KEY);
    this.kv.removeItem(TOMBSTONE_KEY);
  }

  newState(operatorLabel: string): PersistedState {
    return { version: 1, operatorLabel, operatorNotes: "", queue: [], sessions: [], runs: [] };
  }

  /** Append sessions to the queue: engines × models for one cache state. */
  enqueue(
    state: PersistedState,
    engines: EngineId[],
    models: ModelKey[],
    cacheState: CacheState,
  ): PersistedState {
    for (const modelKey of models) {
      for (const engine of engines) {
        state.queue.push({ engine, modelKey, cacheState, status: "pending" });
      }
    }
    this.saveState(state);
    return state;
  }

  nextPending(state: PersistedState): SessionPlanItem | null {
    return state.queue.find((q) => q.status === "pending") ?? null;
  }

  markSession(state: PersistedState, item: SessionPlanItem, status: SessionStatus): void {
    item.status = status;
    this.saveState(state);
  }

  appendRun(state: PersistedState, run: RunRow): void {
    state.runs.push(run);
    this.saveState(state);
  }

  appendSession(state: PersistedState, session: SessionRow): void {
    state.sessions.push(session);
    this.saveState(state);
  }

  // --- tombstone -----------------------------------------------------------

  writeTombstone(t: Tombstone): void {
    this.kv.setItem(TOMBSTONE_KEY, JSON.stringify(t));
  }

  clearTombstone(): void {
    this.kv.removeItem(TOMBSTONE_KEY);
  }

  readTombstone(): Tombstone | null {
    const raw = this.kv.getItem(TOMBSTONE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tombstone;
    } catch {
      return null;
    }
  }

  /**
   * Call on page load. If a tombstone survived a reload, the previous
   * load/generation never completed: record error row(s), abort the session
   * it belonged to (so the plan advances instead of retrying the same session
   * in a kill loop), and clear the marker. Returns the recovered rows, if any.
   *
   * Stage "generate" yields one row for the in-flight prompt; stage "init"
   * yields one row per prompt (same shape as a load failure), since no prompt
   * ever ran.
   */
  recoverTombstone(state: PersistedState): RunRow[] {
    const t = this.readTombstone();
    if (!t) return [];

    const makeRow = (prompt: PromptId): RunRow => ({
      engine: t.engine,
      engine_version: t.engineVersion,
      backend: t.backend,
      model_id: t.modelId,
      quant: t.quant,
      prompt,
      cache_state: t.cacheState,
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
      kv_context_window: t.kvContextWindow,
      prefill_chunk: t.prefillChunk,
      error: {
        stage: t.stage,
        error_name: "probable_oom_tab_kill",
        error_message:
          t.stage === "init"
            ? `session load started ${t.startedAt} never reached ready; page reloaded mid-download/init (likely OOM tab kill)`
            : `run started ${t.startedAt} never completed; page reloaded mid-generation (likely OOM tab kill)`,
      },
    });

    const rows =
      t.stage === "generate" && t.prompt !== null
        ? [makeRow(t.prompt)]
        : ALL_PROMPTS.map(makeRow);
    state.runs.push(...rows);

    // Shared advancement logic for both stages: abort the session so
    // nextPending() moves on, and close the dangling session row.
    const session = state.queue.find(
      (q) =>
        q.status === "pending" &&
        q.engine === t.engine &&
        q.modelKey === t.modelKey &&
        q.cacheState === t.cacheState,
    );
    if (session) session.status = "aborted";
    const openSession = state.sessions.find(
      (s) => s.engine === t.engine && s.ended_at === null && s.cache_state === t.cacheState,
    );
    if (openSession) openSession.ended_at = new Date().toISOString();
    this.clearTombstone();
    this.saveState(state);
    return rows;
  }
}

export function createBrowserStore(): BenchStore {
  return new BenchStore(globalThis.localStorage);
}
