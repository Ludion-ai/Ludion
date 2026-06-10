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
  engine: EngineId;
  engineVersion: string;
  backend: Backend | null;
  modelKey: ModelKey;
  modelId: string;
  quant: string;
  prompt: PromptId;
  cacheState: CacheState;
  startedAt: string;
}

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
   * generation never completed: record it as an error row, abort the session
   * it belonged to, and clear the marker. Returns the recovered row, if any.
   */
  recoverTombstone(state: PersistedState): RunRow | null {
    const t = this.readTombstone();
    if (!t) return null;
    const row: RunRow = {
      engine: t.engine,
      engine_version: t.engineVersion,
      backend: t.backend,
      model_id: t.modelId,
      quant: t.quant,
      prompt: t.prompt,
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
      error: {
        stage: "generate",
        error_name: "probable_oom_tab_kill",
        error_message: `run started ${t.startedAt} never completed; page reloaded mid-generation (likely OOM tab kill)`,
      },
    };
    state.runs.push(row);
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
    return row;
  }
}

export function createBrowserStore(): BenchStore {
  return new BenchStore(globalThis.localStorage);
}
