import { activeSet, checkSource, claimOf, formatLesson, isV1, quotesMissingSymbol, subjectFor, ungroundedWords, validateLesson, type FetchFn, type Lesson, type LessonValidator } from "@ludion/core";
import { interpretRun, type RunFn } from "./docker.ts";

export type Status = "passed" | "failed" | "skipped";
export type Label = "skipped" | "needs-lean" | "retract";

export interface LessonResult {
  file: string;
  id: string | null;
  claim: string | null;
  status: Status;
  reasons: string[];
  labels: Label[];
}

export interface LessonFile {
  /** Path with forward slashes, relative to the repo root, e.g. lessons/python/<id>.json. */
  path: string;
  text: string;
}

export interface VerifyContext {
  /** Lessons on main, used for the active set that `replaces` must point into. */
  base: Lesson[];
  fetchFn: FetchFn;
  /** Executes run evidence. Absent: run evidence is not executed (local use). */
  run?: RunFn;
  /** Schema to validate against. Absent: the precompiled ones (format 1, or format 0 for old files). CI passes the base branch's format 1 schema, so a new lesson must be format 1. */
  validate?: LessonValidator;
}

function firstDifference(actual: string, expected: string): string {
  const a = actual.split("\n");
  const e = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      return `line ${i + 1} is ${JSON.stringify(a[i] ?? "<end of file>")}, expected ${JSON.stringify(e[i] ?? "<end of file>")}`;
    }
  }
  return "the line endings differ";
}

export async function verifyLesson(file: LessonFile, ctx: VerifyContext): Promise<LessonResult> {
  const result: LessonResult = { file: file.path, id: null, claim: null, status: "passed", reasons: [], labels: [] };
  const fail = (reason: string) => {
    result.status = "failed";
    result.reasons.push(reason);
  };
  const skip = (reason: string, label: Label) => {
    if (result.status === "passed") result.status = "skipped";
    result.reasons.push(reason);
    if (!result.labels.includes(label)) result.labels.push(label);
  };

  let data: unknown;
  try {
    data = JSON.parse(file.text);
  } catch (err) {
    fail(`This file is not valid JSON (${(err as Error).message}). Fix the syntax.`);
    return result;
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.id === "string") result.id = d.id;
    if (typeof d.claim === "string") result.claim = d.claim;
  }

  // 1. Schema, then canonical form.
  const valid = (ctx.validate ?? validateLesson)(data);
  if (!valid.ok) {
    for (const e of valid.errors) fail(`${e.path}: ${e.message}`);
    return result;
  }
  const lesson = valid.lesson;
  result.claim = claimOf(lesson);
  const canonical = formatLesson(lesson);
  if (file.text !== canonical) {
    fail(`The file is not in canonical form: ${firstDifference(file.text, canonical)}. Keys go in schema order with 2-space indent, LF line endings, and a trailing newline.`);
  }

  // 2. Path. A format 1 lesson's subject comes from its package.
  const expected = `lessons/${lesson.subject}/${lesson.id}.json`;
  if (file.path !== expected && !file.path.endsWith(`/${expected}`)) {
    fail(`The file must be at ${expected} (subject and id decide the path), not ${file.path}.`);
  }
  if (isV1(lesson) && lesson.subject !== subjectFor(lesson.package)) {
    fail(`The subject for package ${lesson.package.name} is ${subjectFor(lesson.package)}, not ${lesson.subject}.`);
  }

  // 3. Format 1: the only free text is grounded, and sources state the fact by naming the symbol.
  if (isV1(lesson)) {
    const words = ungroundedWords(lesson);
    if (words.length) fail(`The detail uses words the evidence doesn't contain: ${words.join(", ")}. Use the evidence's own words, or leave the detail out.`);
    for (const quote of quotesMissingSymbol(lesson)) {
      fail(`The quote "${quote.slice(0, 80)}" doesn't name ${lesson.symbol}. Quote a sentence that states the fact itself, not a headline.`);
    }
  }

  // 4. replaces must name lessons in the active set on main.
  if (lesson.replaces?.length) {
    const active = new Set(activeSet(ctx.base.filter((l) => l.id !== lesson.id)).map((l) => l.id));
    for (const id of lesson.replaces) {
      if (!active.has(id)) fail(`replaces names ${id}, which is not an active lesson on main. Correct only lessons that are still active.`);
    }
  }

  // 5 and 6. Evidence.
  await Promise.all(
    (lesson.evidence as Lesson["evidence"]).map(async (e, i) => {
      const where = `evidence ${i + 1}`;
      if ("source" in e) {
        const r = await checkSource(e.source.url, e.source.quote, ctx.fetchFn);
        if (!r.found) fail(`${where} (source): ${r.reason}`);
        return;
      }
      if ("run" in e && e.run.runner === "lean") {
        skip(`${where} (lean): the Lean runner does not exist yet. A human decides.`, "needs-lean");
        return;
      }
      if (!ctx.run) return;
      const spec = "run" in e ? { runtime: e.run.runner, code: e.run.code } : { runtime: e.test.runtime, code: e.test.code, packages: e.test.packages };
      const label = "run" in e ? e.run.runner : e.test.runtime + (e.test.packages ? ` ${Object.entries(e.test.packages).map(([n, v]) => `${n}@${v}`).join(" ")}` : "");
      const r = interpretRun(await ctx.run(spec), "test" in e ? e.test.expect : "pass", "test" in e ? e.test.error : undefined);
      if (r.status === "failed") fail(`${where} (${label}): ${r.reason}`);
      if (r.status === "skipped") skip(`${where} (${label}): ${r.reason}`, "skipped");
    }),
  );
  return result;
}

export function summaryLine(r: LessonResult): string {
  const claim = (r.claim ?? "").replace(/\s+/g, " ").slice(0, 60);
  return `${r.status.padEnd(7)}  ${r.id ?? r.file}  ${claim}`.trimEnd();
}
