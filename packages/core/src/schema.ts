import { validate as generatedV1, type AjvError, type ValidateFn } from "./generated/validate-lesson.js";
import { validate as generatedV0 } from "./generated/validate-lesson-v0.js";
import type { Lesson } from "./types.ts";

export interface FieldError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; lesson: Lesson } | { ok: false; errors: FieldError[] };

const FIELD_MESSAGES: Record<string, string> = {
  "/format": "New lessons are format 1: add \"format\": 1.",
  "/id": "The id must be a ULID: 26 characters of Crockford base32 (0-9, A-Z without I, L, O, U).",
  "/subject": "Write the subject in lowercase, like python or wrangler: letters, digits, dots, and dashes, up to 64 characters.",
  "/package": 'Give the package as {"ecosystem": "npm" | "pypi" | "runtime", "name": "<name as the lockfile writes it>"}.',
  "/versions": "Write the versions as a semver range where the fact holds, for example >=5.0.0.",
  "/kind": "Choose a kind: removed, renamed, deprecated, added, default, or behavior.",
  "/symbol": "Name the API, option, command, or flag that changed, as written in code, in at most 120 characters.",
  "/replacement": "Name what to use instead, as written in code, in at most 120 characters. A renamed lesson needs one.",
  "/signal": "Choose a signal: loud (old code fails with an error) or silent (old code still runs and does the wrong thing).",
  "/detail": "Write at most one short sentence of up to 160 characters, or leave the detail out.",
  "/version": "Write the version as text, for example >=3.12, or leave it out.",
  "/claim": "Write one sentence of 10 to 400 characters.",
  "/evidence": "Give 1 to 3 pieces of evidence: a test or a source.",
  "/author": "The author must be github:<login> of the account that opened the pull request.",
  "/author_id": "The author_id must be the numeric GitHub user id of the account that opened the pull request (a whole number, 1 or more).",
  "/drafted_by": 'Set drafted_by to "agent" when an agent drafted the lesson, or leave it out.',
  "/replaces": "List the ids (ULIDs) of the lessons this one corrects.",
  "/created_at": "The time must be UTC in the form YYYY-MM-DDTHH:MM:SSZ.",
};

/** For symbol, replacement, and detail: in the order of each field's allOf in lessons.schema.json. */
const TEXT_GUARDS = [
  "Remove invisible characters and line breaks: this is one line of plain text.",
  "Remove the link. Links belong in a source, with a sentence quoted from the page.",
  "Remove the command line (a pipe into a shell, curl or wget into a pipe, rm -rf, or $(...)). Runnable code goes in a test.",
  "Remove the instructions to an AI or to the reader. The detail states a fact.",
];

const SUBJECT_GUARD =
  "This subject can't be a directory or branch name: no '..', no '.' or '-' at the end, no '.lock' ending, and not con, prn, aux, nul, com0-9, or lpt0-9.";

const EVIDENCE_MESSAGES: Record<string, string> = {
  run: 'A test needs "runner" (python, bash, node, or lean) and "code" (up to 8000 characters) that exits 0 only if the claim is true.',
  "run/runner": "Choose a runner: python, bash, node, or lean.",
  "run/code": "Test code must be text of at most 8000 characters that exits 0 only if the claim is true.",
  test: 'A test needs "runtime" (node@24, python@3.12, …) and "code" (up to 8000 characters) that exits 0 only if the fact holds; "packages", "expect", and "error" are optional.',
  "test/runtime": "Choose a runtime: node@18, node@20, node@22, node@24, or python@3.9 to python@3.14.",
  "test/packages": 'List at most 5 packages as {"name": "exact version"}, for example {"vitest": "5.0.3"}.',
  "test/code": "Test code must be text of at most 8000 characters that exits 0 only if the fact holds.",
  "test/expect": 'Set "expect" to "pass" (the default) or "fail".',
  "test/error": "Write the error as text of 8 to 300 characters that the test's output must contain.",
  source: 'A source needs "url" and "quote".',
  "source/url": "The source URL must start with https://.",
  "source/quote": "Paste an exact sentence from the page that states the fact: 40 to 300 characters in format 1 (8 to 300 in format 0).",
};

const EVIDENCE_SHAPE = 'Each piece of evidence is either a test, {"test": {"runtime", "code"}} (format 0: {"run": {"runner", "code"}}), or a source, {"source": {"url", "quote"}}.';

/** Which oneOf branch an evidence item meant to be: 0 for a test, 1 for a source, undefined if unclear. */
function intendedBranch(item: unknown): number | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const keys = Object.keys(item);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "run" || keys[0] === "test") return 0;
  if (keys[0] === "source") return 1;
  return undefined;
}

function messageFor(err: AjvError, data: unknown): FieldError | undefined {
  const path = err.instancePath;
  if (path === "" && err.keyword === "required") {
    const field = `/${String(err.params.missingProperty)}`;
    return { path: field, message: FIELD_MESSAGES[field] ?? `Add the missing field ${field.slice(1)}.` };
  }
  if (path === "" && err.keyword === "additionalProperties") {
    const field = String(err.params.additionalProperty);
    return { path: `/${field}`, message: `Remove the field "${field}"; lessons do not have it.` };
  }
  if (path === "" && (err.keyword === "if" || err.keyword === "allOf")) return undefined;
  if (path === "") return { path: "/", message: "A lesson must be a JSON object." };

  const m = /^\/evidence\/(\d+)(\/.*)?$/.exec(path);
  if (m) {
    const index = Number(m[1]);
    const item = (data as { evidence?: unknown[] }).evidence?.[index];
    const branch = intendedBranch(item);
    if (branch === undefined) return { path: `/evidence/${index}`, message: EVIDENCE_SHAPE };
    // Errors from the branch this item did not mean to be are noise.
    if (!err.schemaPath.startsWith(`#/properties/evidence/items/oneOf/${branch}/`)) return undefined;
    const rest = (m[2] ?? "").slice(1);
    if (err.keyword === "additionalProperties") {
      return { path, message: `Remove "${String(err.params.additionalProperty)}". ${EVIDENCE_MESSAGES[rest] ?? EVIDENCE_SHAPE}` };
    }
    if ((rest === "run" || rest === "test") && err.keyword === "required" && err.params.missingProperty === "error") {
      return { path, message: 'A test with "expect": "fail" needs "error": text its output must contain.' };
    }
    if ((rest === "run" || rest === "test") && err.keyword === "not") {
      return { path, message: '"error" goes only with "expect": "fail". Remove it, or set "expect": "fail".' };
    }
    if (err.keyword === "if") return undefined;
    const key = rest.startsWith("test/packages") ? "test/packages" : rest;
    return { path, message: EVIDENCE_MESSAGES[key] ?? EVIDENCE_SHAPE };
  }

  if (path === "/symbol" || path === "/replacement" || path === "/detail") {
    const guard = new RegExp(`^#/properties/${path.slice(1)}/allOf/(\\d)/`).exec(err.schemaPath)?.[1];
    if (guard !== undefined && TEXT_GUARDS[Number(guard)]) return { path, message: TEXT_GUARDS[Number(guard)]! };
  }
  if (path === "/subject" && err.keyword === "not") return { path, message: SUBJECT_GUARD };

  const top = "/" + (path.split("/")[1] ?? "");
  return { path, message: FIELD_MESSAGES[top] ?? `This value is not valid: ${err.message ?? err.keyword}.` };
}

export type LessonValidator = (data: unknown) => ValidationResult;

/** Wrap any Ajv validate function compiled from a lesson schema, with person-readable errors. */
export function lessonValidator(validate: ValidateFn): LessonValidator {
  return (data) => runValidator(validate, data);
}

/** Format 1, the only format new lessons may use (lessons/lessons.schema.json). */
export const validateLessonV1: LessonValidator = lessonValidator(generatedV1);

/** Format 0, frozen (lessons/lessons-v0.schema.json): only for lessons already on main. */
export const validateLessonV0: LessonValidator = lessonValidator(generatedV0);

/** Any lesson file: format 1 when it says so, else format 0. */
export const validateLesson: LessonValidator = (data) =>
  data !== null && typeof data === "object" && (data as { format?: unknown }).format !== undefined ? validateLessonV1(data) : validateLessonV0(data);

function runValidator(validate: ValidateFn, data: unknown): ValidationResult {
  if (validate(data)) return { ok: true, lesson: data as Lesson };
  const seen = new Set<string>();
  const errors: FieldError[] = [];
  for (const err of validate.errors ?? []) {
    const e = messageFor(err, data);
    if (!e) continue;
    const key = `${e.path}\n${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(e);
  }
  if (errors.length === 0) errors.push({ path: "/", message: "This lesson does not match lessons/lessons.schema.json." });
  return { ok: false, errors };
}
