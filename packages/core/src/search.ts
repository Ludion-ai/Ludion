import MiniSearch from "minisearch";
import type { Index, IndexEntry } from "./types.ts";

interface Searcher {
  mini: MiniSearch<IndexEntry>;
  byId: Map<string, IndexEntry>;
}

const searchers = new WeakMap<Index, Searcher>();

function searcherFor(index: Index): Searcher {
  let s = searchers.get(index);
  if (!s) {
    const mini = new MiniSearch<IndexEntry>({ fields: ["claim", "subject"], idField: "id" });
    mini.addAll(index.lessons);
    s = { mini, byId: new Map(index.lessons.map((l) => [l.id, l])) };
    searchers.set(index, s);
  }
  return s;
}

export interface SearchOptions {
  subject?: string;
  k?: number;
}

export function search(index: Index, query: string, { subject, k = 5 }: SearchOptions = {}): IndexEntry[] {
  const { mini, byId } = searcherFor(index);
  const results = mini.search(query, {
    boost: { claim: 2, subject: 1 },
    prefix: true,
    fuzzy: 0.2,
    filter: subject ? (r) => byId.get(r.id)?.subject === subject : undefined,
  });
  return results.slice(0, k).map((r) => byId.get(r.id)!);
}
