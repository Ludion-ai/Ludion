import MiniSearch from "minisearch";
import { COMMON_WORDS } from "./common-words.ts";
import type { Index, IndexEntry } from "./types.ts";

// Search returns a lesson only when what matched says the lesson is about the question:
//   - a strong word: an identifier (distutils), a version number (3.12), a flag (--discard-changes), a CSS
//     pseudo-class (:has), a word in capitals or camelCase (RETURNING, moduleResolution), or any word not on the
//     common-word list;
//   - or, when the question has no strong word at all, at least two common words;
//   - or a word the lesson writes as code (RETURNING), even in lowercase, plus one more word of the question.
// A long question (a pasted log) is searched by its last error line and its strong words.
// Subject names (python, git) never count: "What is Python?" finds nothing.
// Checked by test/search-eval.test.ts (off-topic questions must find nothing; on-topic ones the right lesson in the top 3).

/** Results scoring under this share of the best result are dropped. */
const MIN_RELATIVE_SCORE = 0.5;
/** Common words a lesson must match when the question has no strong word. */
const MIN_COMMON_MATCHES = 2;

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

/**
 * Words with their original case. Flags (-V, --discard-changes) and pseudo-classes (:has) stay whole, version numbers
 * (3.12) stay whole, and words split wherever the script changes: between letters and digits (python3 → python, 3) and
 * between Latin and Japanese or Chinese (distutilsはPython → distutils, は, Python).
 */
const WORD =
  /(?<![\p{L}\p{N}-])--?\p{L}[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*|(?<![\p{L}\p{N}:])::?\p{L}[\p{L}-]*|\d+(?:\.\d+)+|\d+|\p{Script=Latin}+|\p{Script=Han}+|\p{Script=Hiragana}+|[\p{Script=Katakana}ー]+|\p{L}+/gu;

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

export function tokenize(text: string): string[] {
  return words(text).map((w) => w.toLowerCase());
}

/** Version numbers, flags and pseudo-classes: matched exactly, never stemmed, never by prefix or typo. */
const isExact = (term: string) => /^[\d:-]/.test(term);

/** A light English stemmer: plural -s, then -ing or -ed. */
function stem(term: string): string {
  if (isExact(term)) return term;
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

/** Common words as stems, with their usual endings, so "moving" and "changes" are as common as "move" and "change". */
const COMMON = new Set(
  COMMON_WORDS.flatMap((w) => {
    const bare = w.replace(/e$/, "");
    return [w, `${w}s`, `${w}d`, `${w}ed`, `${w}ing`, `${bare}ing`, `${bare}ed`, `${w}er`, `${w}ly`, `${bare}er`].map(stem);
  }),
);

/** Written as code: all capitals (RETURNING) or camelCase (moduleResolution). */
const isCodeLike = (original: string) => /^[A-Z]{2,}$/.test(original) || /[a-z][A-Z]/.test(original);

/** Strong unless it is a common word, a plain number, a single letter, or not in Latin script. */
function isStrong(term: string, original: string): boolean {
  if (/^\d+(\.\d+)+$/.test(term) || /^[:-]/.test(term)) return true;
  if (!/^[a-z]{2,}$/.test(term)) return false;
  if (isCodeLike(original)) return true;
  return !COMMON.has(term);
}

interface Searcher {
  mini: MiniSearch<IndexEntry>;
  byId: Map<string, IndexEntry>;
  /** Words of every subject name: they never count as a match. */
  subjectTerms: Set<string>;
  /** Per lesson id, the words its claim writes as code. */
  codeTerms: Map<string, Set<string>>;
}

const searchers = new WeakMap<Index, Searcher>();

/** Words a lesson writes as code: in capitals (RETURNING), camelCase (moduleResolution), or inside `backticks`. */
function codeTermsOf(claim: string, subjectTerms: Set<string>): Set<string> {
  const code = [
    ...words(claim).filter(isCodeLike),
    ...[...claim.matchAll(/`([^`]+)`/g)].flatMap((m) => words(m[1]!)),
  ];
  return new Set(code.map((w) => processTerm(w.toLowerCase())).filter((t): t is string => !!t && !subjectTerms.has(t)));
}

function searcherFor(index: Index): Searcher {
  let s = searchers.get(index);
  if (!s) {
    const mini = new MiniSearch<IndexEntry>({ fields: ["claim", "subject"], idField: "id", tokenize, processTerm });
    mini.addAll(index.lessons);
    const subjectTerms = new Set(
      index.lessons.flatMap((l) => tokenize(l.subject).map(processTerm)).filter((t): t is string => !!t),
    );
    const codeTerms = new Map(index.lessons.map((l) => [l.id, codeTermsOf(l.claim, subjectTerms)]));
    s = { mini, byId: new Map(index.lessons.map((l) => [l.id, l])), subjectTerms, codeTerms };
    searchers.set(index, s);
  }
  return s;
}

export interface SearchOptions {
  subject?: string;
  k?: number;
}

/** Questions longer than this (a pasted log or traceback) are searched by their error line and strong words. */
const LONG_QUESTION = 500;
/** At most this many strong words from a long question, nearest the error first. */
const MAX_FOCUS_WORDS = 20;
/** A line that reports the error: "ModuleNotFoundError: ...", "Error: Cannot find module ...", "error[E0133]: ...". */
const ERROR_LINE = /^\s*[\w.$]*(?:error|exception|warning)(?:\[\w+\])?\s*:/i;

/**
 * What to search for. A short question as it is. A long one becomes its last error line plus its strong words, taken
 * from the error line first and then from the end backwards, so the file paths and frames above don't drown it out.
 */
function focus(query: string, strongWord: (original: string) => boolean): string {
  if (query.length <= LONG_QUESTION) return query;
  const errorLine = query.split(/\r?\n/).findLast((l) => ERROR_LINE.test(l))?.trim() ?? "";
  const picked = new Set<string>();
  for (const w of [...words(errorLine), ...words(query).reverse()]) {
    if (picked.size >= MAX_FOCUS_WORDS) break;
    if (strongWord(w)) picked.add(w.toLowerCase());
  }
  const focused = [errorLine, ...picked].join(" ").trim();
  return focused || query.slice(-LONG_QUESTION);
}

export function search(index: Index, query: string, { subject, k = 5 }: SearchOptions = {}): IndexEntry[] {
  const { mini, byId, subjectTerms, codeTerms } = searcherFor(index);

  /** The word's stem, and whether it is strong; null for stopwords and subject names, which never count. */
  const classify = (original: string): { term: string; strong: boolean } | null => {
    const term = processTerm(original.toLowerCase());
    if (!term || subjectTerms.has(term)) return null;
    return { term, strong: isStrong(term, original) };
  };
  const question = focus(query, (w) => classify(w)?.strong ?? false);

  // Sort the question's words into strong and common.
  const strong = new Map<string, string>(); // stem → the word as typed, lowercased
  const common = new Set<string>();
  for (const original of words(question)) {
    const c = classify(original);
    if (c?.strong) strong.set(c.term, original.toLowerCase());
    else if (c) common.add(c.term);
  }

  const options = {
    boost: { claim: 2, subject: 1 },
    // Prefix matching only for words of 4+ characters, fuzzy only for 5+; never for version numbers or flags.
    prefix: (term: string) => term.length >= 4 && !isExact(term),
    fuzzy: (term: string) => (term.length >= 5 && !isExact(term) ? 0.2 : false),
    filter: subject ? (r: { id: string }) => byId.get(r.id)?.subject === subject : undefined,
  };
  const results = mini.search(question, options);
  const matched = new Set<string>();

  if (strong.size > 0) {
    // A lesson must match one of the strong words, and what it matched in the lesson must not be a subject name or,
    // unless typed as code (RETURNING), a common word: "inst" finding "instead" doesn't count.
    for (const r of mini.search({ combineWith: "OR", queries: [...strong.values()] }, options)) {
      if (r.terms.some((t) => !subjectTerms.has(t) && (!COMMON.has(t) || strong.has(t)))) matched.add(r.id);
    }
  } else {
    // No strong word: at least two common words.
    for (const r of results) {
      if (new Set(r.queryTerms.filter((t) => common.has(t))).size >= MIN_COMMON_MATCHES) matched.add(r.id);
    }
  }

  // A word the lesson writes as code (RETURNING) is strong for that lesson even when the question has it in lowercase,
  // as long as the lesson matches another word of the question too: "sqlite returning" finds it, "how do I return" doesn't.
  for (const r of results) {
    const code = codeTerms.get(r.id)!;
    const asked = new Set(r.queryTerms);
    if (asked.size >= 2 && [...asked].some((q) => code.has(q) && r.terms.includes(q))) matched.add(r.id);
  }

  // Rank by the whole (focused) question.
  const ranked = results.filter((r) => matched.has(r.id));
  const top = ranked[0]?.score ?? 0;
  return ranked
    .filter((r) => r.score >= top * MIN_RELATIVE_SCORE)
    .slice(0, k)
    .map((r) => byId.get(r.id)!);
}