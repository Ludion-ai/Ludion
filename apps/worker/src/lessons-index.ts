import type { Index } from "@ludion/core";

const REVALIDATE_MS = 60_000;

let cached: { index: Index; checkedAt: number } | undefined;

/**
 * index.json from the deployed assets, kept in module scope and revalidated at most every 60 s.
 * The same Index object is kept while `built_at` is unchanged, so search's per-index cache is reused.
 */
export async function lessonsIndex(assets: Fetcher, now: number = Date.now()): Promise<Index> {
  if (cached && now - cached.checkedAt < REVALIDATE_MS) return cached.index;
  try {
    const res = await assets.fetch("https://assets.local/index.json");
    if (!res.ok) throw new Error(`index.json answered HTTP ${res.status}`);
    const fresh = (await res.json()) as Index;
    const index = cached && cached.index.built_at === fresh.built_at ? cached.index : fresh;
    cached = { index, checkedAt: now };
    return index;
  } catch (err) {
    // Serve the last good index rather than failing the request; retry on the next window.
    if (cached) {
      cached.checkedAt = now;
      return cached.index;
    }
    throw err;
  }
}

/** For tests only. */
export function resetLessonsIndex(): void {
  cached = undefined;
}
