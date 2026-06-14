import type { BenchDocument } from "./schema";
import type { KV } from "./state";

/**
 * Submit-once store (Gate 5 §1, decisions B-1). Mirrors the StrikeStore
 * pattern (router/src/strikes.ts): same KV interface, a versioned blob,
 * JSON-recovery on read, and fail-open writes (a write that throws must never
 * strand the UI — the worst case is a re-submittable result, which the Worker
 * dedupe still catches as the final safety net).
 *
 * The key is the result's CONTENT HASH:
 *   contentHash(doc) = SHA-256( JSON.stringify(doc) )  (hex, lowercase)
 * which is byte-identical to the Worker's dedupe input — it hashes the exact
 * POST body, and submit.ts POSTs `JSON.stringify(doc)` (collector handler.ts:
 * bodyBytes = TextEncoder().encode(await request.text())). So client and
 * server agree on "same measurement" (decisions OQ1). This only holds because
 * `collected_at` is frozen per measurement (decisions B-2) — otherwise every
 * rebuild of the doc would hash differently.
 */

const SUBMITTED_KEY = "ludion.bench.submitted.v1";

interface SubmittedBlob {
  version: 1;
  hashes: string[];
}

export class SubmittedStore {
  constructor(private readonly kv: KV) {}

  private read(): SubmittedBlob {
    try {
      const raw = this.kv.getItem(SUBMITTED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SubmittedBlob;
        if (parsed.version === 1 && Array.isArray(parsed.hashes)) return parsed;
      }
    } catch {
      // fall through to a fresh blob
    }
    return { version: 1, hashes: [] };
  }

  private write(blob: SubmittedBlob): void {
    try {
      this.kv.setItem(SUBMITTED_KEY, JSON.stringify(blob));
    } catch {
      // fail-open: never throw (decisions B-1)
    }
  }

  has(hash: string): boolean {
    return this.read().hashes.includes(hash);
  }

  add(hash: string): void {
    const blob = this.read();
    if (!blob.hashes.includes(hash)) {
      blob.hashes.push(hash);
      this.write(blob);
    }
  }
}

/**
 * The one content-hash definition the client persists and the server dedupes
 * on. Must stay byte-identical to the Worker (collector handler.ts sha256Hex).
 */
export async function contentHash(doc: BenchDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Browser KV that can never throw: falls back to in-memory on any failure. */
function createSafeBrowserKV(): KV {
  const memory = (): KV => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  };
  let inner: KV;
  try {
    const ls = globalThis.localStorage;
    ls.setItem("ludion.bench.kvprobe", "1");
    ls.removeItem("ludion.bench.kvprobe");
    inner = ls;
  } catch {
    inner = memory();
  }
  const fallback = (): KV => (inner = memory());
  return {
    getItem(k) {
      try {
        return inner.getItem(k);
      } catch {
        return fallback().getItem(k);
      }
    },
    setItem(k, v) {
      try {
        inner.setItem(k, v);
      } catch {
        fallback().setItem(k, v);
      }
    },
    removeItem(k) {
      try {
        inner.removeItem(k);
      } catch {
        fallback().removeItem(k);
      }
    },
  };
}

export function createBrowserSubmittedStore(): SubmittedStore {
  return new SubmittedStore(createSafeBrowserKV());
}
