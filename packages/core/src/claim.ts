// Format 1 lessons have no free-written claim. The sentence assistants read is generated from the structured
// fields; the only free text is `detail`, and every meaningful word in it must appear in the evidence (CLAUDE.md,
// "Claims are generated, not written").
import { processTerm, tokenize } from "./search.ts";
import type { Lesson, LessonV1 } from "./types.ts";
import { isV1 } from "./types.ts";

/** The directory for a package: npm @scope/name → scope.name; anything else lowercased as is. */
export function subjectFor(pkg: LessonV1["package"]): string {
  return pkg.name.replace(/^@/, "").replace("/", ".").toLowerCase();
}

/** A code span. The schema forbids backticks in symbols; stripping them here too means no field can end the span early. */
const code = (s: string) => `\`${s.replace(/`/g, "")}\``;

/** "detail text" → "Detail text." */
function sentence(text: string): string {
  const t = text.trim();
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The sentence an assistant reads, built from the fields. Same fields, same sentence. */
export function generateClaim(l: Pick<LessonV1, "package" | "versions" | "kind" | "symbol" | "replacement" | "signal" | "detail">): string {
  const where = `${l.package.name} ${l.versions}`;
  const use = l.replacement ? `; use ${code(l.replacement)} instead` : "";
  const head = {
    removed: `${where} removed ${code(l.symbol)}${use}.`,
    renamed: `${where} renamed ${code(l.symbol)} to ${code(l.replacement ?? "")}.`,
    deprecated: `${where} deprecated ${code(l.symbol)}${use}.`,
    added: `${where} added ${code(l.symbol)}.`,
    default: `${where} changed the default of ${code(l.symbol)}.`,
    behavior: `${where} changed what ${code(l.symbol)} does.`,
  }[l.kind];
  const parts = [head];
  if (l.detail) parts.push(sentence(l.detail));
  if (l.signal === "silent") parts.push("Silent: code written for older versions still runs, without an error.");
  return parts.join(" ");
}

/** The claim of any lesson: format 0's as written, format 1's generated. */
export function claimOf(l: Lesson): string {
  return isV1(l) ? generateClaim(l) : l.claim;
}

/** Where the fact holds, for display: format 0's version, format 1's versions. */
export function versionOf(l: Lesson): string | undefined {
  return isV1(l) ? l.versions : (l.version ?? undefined);
}

/** Meaningful words as search sees them: lowercased, stopwords dropped, lightly stemmed. */
function meaningful(text: string): string[] {
  return tokenize(text).map(processTerm).filter((t): t is string => !!t && t.length > 1);
}

/** Every text a lesson's detail may draw on: its evidence, plus the fields the claim already states. */
function evidenceText(l: LessonV1): string {
  const parts = [l.package.name, l.versions, l.symbol, l.replacement ?? ""];
  for (const e of l.evidence) {
    if ("test" in e) parts.push(e.test.code, e.test.error ?? "", ...Object.keys(e.test.packages ?? {}));
    else parts.push(e.source.quote);
  }
  return parts.join("\n");
}

/** Words in `detail` that appear nowhere in the evidence. Empty when the detail is grounded (or absent). */
export function ungroundedWords(l: LessonV1): string[] {
  if (!l.detail) return [];
  const known = new Set(meaningful(evidenceText(l)));
  return [...new Set(meaningful(l.detail))].filter((w) => !known.has(w));
}

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[`'"“”‘’]/g, "").replace(/\s+/g, " ");

/** Source quotes must state the fact itself, so each must name the symbol. Returns the quotes that don't. */
export function quotesMissingSymbol(l: LessonV1): string[] {
  const symbol = normalize(l.symbol);
  return l.evidence.flatMap((e) => ("source" in e && !normalize(e.source.quote).includes(symbol) ? [e.source.quote] : []));
}
