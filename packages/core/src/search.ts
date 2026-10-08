import MiniSearch from "minisearch";
import type { Index, IndexEntry } from "./types.ts";

// Search returns a lesson only when the question's meaningful words match it. Thresholds are set by
// test/search-eval.test.ts (off-topic questions must find nothing; on-topic ones the right lesson in the top 3).

/** Share of the question's meaningful words a lesson must match. */
const MIN_COVERAGE = 0.5;
/** Results scoring under this share of the best result are dropped. */
const MIN_RELATIVE_SCORE = 0.5;

/** Common English words that say nothing about a lesson. Removed from questions and lessons alike. */
const STOPWORDS = new Set(
  (
    "a about above after again all also am an and any are aren as at be because been before being below between both but by " +
    "can cannot could couldn did didn do does doesn doing don down during each else even ever every few for from further get " +
    "gets getting got had has hasn have haven having he her here hers how however i if in into is isn it its itself just " +
    "let like ll make makes me might more most much must my need needs no nor not now of off on once only or other our out " +
    "over own please re same shall she should so some still such than that the their them then there these they thing " +
    "things this those through to too under until up us use used uses using ve very want was wasn way we were weren what " +
    "when where whether which while who whom why will with within without won would yet you your yours s t d m"
  ).split(" "),
);

/** Words, keeping version numbers such as 3.12 or 1.10 whole. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\d+(?:\.\d+)+|[\p{L}\p{N}]+/gu) ?? [];
}

/** A light English stemmer: plural -s, then -ing or -ed. Version numbers stay as they are. */
function stem(term: string): string {
  if (/^\d/.test(term)) return term;
  let s = term;
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  return s;
}

/** Stopwords dropped, the rest stemmed. The same for lessons and questions. */
export function processTerm(term: string): string | null {
  return STOPWORDS.has(term) ? null : stem(term);
}

const isNumber = (term: string) => /^\d/.test(term);

interface Searcher {
  mini: MiniSearch<IndexEntry>;
  byId: Map<string, IndexEntry>;
}

const searchers = new WeakMap<Index, Searcher>();

function searcherFor(index: Index): Searcher {
  let s = searchers.get(index);
  if (!s) {
    const mini = new MiniSearch<IndexEntry>({ fields: ["claim", "subject"], idField: "id", tokenize, processTerm });
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
  const meaningful = new Set(tokenize(query).map(processTerm).filter((t): t is string => !!t));
  if (meaningful.size === 0) return [];
  const { mini, byId } = searcherFor(index);
  const results = mini
    .search(query, {
      boost: { claim: 2, subject: 1 },
      // Prefix matching only for words of 4+ characters, fuzzy only for 5+; never for version numbers.
      prefix: (term) => term.length >= 4 && !isNumber(term),
      fuzzy: (term) => (term.length >= 5 && !isNumber(term) ? 0.2 : false),
      filter: subject ? (r) => byId.get(r.id)?.subject === subject : undefined,
    })
    .filter((r) => new Set(r.queryTerms).size / meaningful.size >= MIN_COVERAGE);
  const top = results[0]?.score ?? 0;
  return results
    .filter((r) => r.score >= top * MIN_RELATIVE_SCORE)
    .slice(0, k)
    .map((r) => byId.get(r.id)!);
}
