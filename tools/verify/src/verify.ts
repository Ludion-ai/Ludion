import { activeSet, checkSource, formatLesson, validateLesson, type FetchFn, type Lesson } from "@ludion/core";
import type { RunFn } from "./docker.ts";

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
  const valid = validateLesson(data);
  if (!valid.ok) {
    for (const e of valid.errors) fail(`${e.path}: ${e.message}`);
    return result;
  }
  const lesson = valid.lesson;
  const canonical = formatLesson(lesson);
  if (file.text !== canonical) {
    fail(`The file is not in canonical form: ${firstDifference(file.text, canonical)}. Keys go in schema order with 2-space indent, LF line endings, and a trailing newline.`);
  }

  // 2. Path.
  const expected = `lessons/${lesson.subject}/${lesson.id}.json`;
  if (file.path !== expected && !file.path.endsWith(`/${expected}`)) {
    fail(`The file must be at ${expected} (subject and id decide the path), not ${file.path}.`);
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
    lesson.evidence.map(async (e, i) => {
      const where = `evidence ${i + 1}`;
      if ("source" in e) {
        const r = await checkSource(e.source.url, e.source.quote, ctx.fetchFn);
        if (!r.found) fail(`${where} (source): ${r.reason}`);
        return;
      }
      if (e.run.runner === "lean") {
        skip(`${where} (lean): the Lean runner does not exist yet. A human decides.`, "needs-lean");
        return;
      }
      if (!ctx.run) return;
      const r = await ctx.run(e.run.runner, e.run.code);
      if (r.status === "failed") fail(`${where} (${e.run.runner}): ${r.reason}`);
      if (r.status === "skipped") skip(`${where} (${e.run.runner}): ${r.reason}`, "skipped");
    }),
  );
  return result;
}

export function summaryLine(r: LessonResult): string {
  const claim = (r.claim ?? "").replace(/\s+/g, " ").slice(0, 60);
  return `${r.status.padEnd(7)}  ${r.id ?? r.file}  ${claim}`.trimEnd();
}
