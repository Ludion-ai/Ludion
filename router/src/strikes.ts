/**
 * Strike store — production reuse of the bench tombstone lesson (spec
 * Section 6, decisions Q5). Same mechanism as bench, separate keys and
 * schema, zero interference (`ludion.bench.*` vs `ludion.router.*`).
 *
 * Scoring: kill (tombstone survives reload) = +1.0; caught local failure
 * = +0.5; score >= 1 short-circuits policy to server for that model_id.
 * TTL (default 7 days) is evaluated lazily on read; tests inject the clock.
 * Strike state is origin-scoped — the natural localStorage behavior, made
 * explicit here (B-5).
 *
 * B-5: this store must NEVER throw. localStorage that throws (private mode,
 * quota, disabled) degrades to an in-memory map for the session.
 */

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STRIKES_KEY = "ludion.router.strikes.v1";
const TOMBSTONE_KEY = "ludion.router.tombstone.v1";

export const DEFAULT_STRIKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STRIKE_KILL = 1.0;
export const STRIKE_CAUGHT = 0.5;
export const STRIKE_THRESHOLD = 1.0;

interface StrikeEntry {
  score: number;
  updated_at: string;
}

interface StrikesBlob {
  version: 1;
  strikes: Record<string, StrikeEntry>;
}

export interface RouterTombstone {
  version: 1;
  model_id: string;
  /** "load" covers download/init kills; "generate" covers in-flight kills. */
  stage: "load" | "generate";
  started_at: string;
}

function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** Browser KV that can never throw: falls back to in-memory on any failure. */
export function createSafeBrowserKV(): KV {
  let inner: KV;
  try {
    const ls = globalThis.localStorage;
    ls.setItem("ludion.router.kvprobe", "1");
    ls.removeItem("ludion.router.kvprobe");
    inner = ls;
  } catch {
    inner = memoryKV();
  }
  const fallbackOnce = (): KV => (inner = memoryKV());
  return {
    getItem(k) {
      try {
        return inner.getItem(k);
      } catch {
        return fallbackOnce().getItem(k);
      }
    },
    setItem(k, v) {
      try {
        inner.setItem(k, v);
      } catch {
        fallbackOnce().setItem(k, v);
      }
    },
    removeItem(k) {
      try {
        inner.removeItem(k);
      } catch {
        fallbackOnce().removeItem(k);
      }
    },
  };
}

export class StrikeStore {
  constructor(
    private readonly kv: KV,
    private readonly ttlMs: number = DEFAULT_STRIKE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): StrikesBlob {
    try {
      const raw = this.kv.getItem(STRIKES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StrikesBlob;
        if (parsed.version === 1 && parsed.strikes) return parsed;
      }
    } catch {
      // fall through to fresh blob
    }
    return { version: 1, strikes: {} };
  }

  private write(blob: StrikesBlob): void {
    try {
      this.kv.setItem(STRIKES_KEY, JSON.stringify(blob));
    } catch {
      // B-5: never throw
    }
  }

  /** Lazy TTL eviction: expired entries are deleted on read. */
  getScore(modelId: string): number {
    const blob = this.read();
    const entry = blob.strikes[modelId];
    if (!entry) return 0;
    const age = this.now() - Date.parse(entry.updated_at);
    if (!(age <= this.ttlMs)) {
      // also evicts NaN updated_at
      delete blob.strikes[modelId];
      this.write(blob);
      return 0;
    }
    return entry.score;
  }

  isStruck(modelId: string): boolean {
    return this.getScore(modelId) >= STRIKE_THRESHOLD;
  }

  addStrike(modelId: string, amount: number): number {
    const current = this.getScore(modelId); // applies TTL first
    const blob = this.read();
    const score = current + amount;
    blob.strikes[modelId] = { score, updated_at: new Date(this.now()).toISOString() };
    this.write(blob);
    return score;
  }

  /** Snapshot for the decision log. */
  snapshot(): Record<string, number> {
    const blob = this.read();
    const out: Record<string, number> = {};
    for (const [id, entry] of Object.entries(blob.strikes)) out[id] = entry.score;
    return out;
  }

  // --- tombstone (in-flight marker) ---------------------------------------

  writeTombstone(modelId: string, stage: RouterTombstone["stage"]): void {
    try {
      const t: RouterTombstone = {
        version: 1,
        model_id: modelId,
        stage,
        started_at: new Date(this.now()).toISOString(),
      };
      this.kv.setItem(TOMBSTONE_KEY, JSON.stringify(t));
    } catch {
      // never throw
    }
  }

  clearTombstone(): void {
    try {
      this.kv.removeItem(TOMBSTONE_KEY);
    } catch {
      // never throw
    }
  }

  readTombstone(): RouterTombstone | null {
    try {
      const raw = this.kv.getItem(TOMBSTONE_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw) as RouterTombstone;
      return t.version === 1 ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Call on boot. A surviving tombstone means the previous load/generate
   * never completed (probable OOM tab kill): +1.0 strike for that model.
   */
  recoverTombstone(): RouterTombstone | null {
    const t = this.readTombstone();
    if (!t) return null;
    this.addStrike(t.model_id, STRIKE_KILL);
    this.clearTombstone();
    return t;
  }
}
