import { validate as generatedValidate, type AjvError, type ValidateFn } from "./generated/validate-lesson.js";
import type { Lesson } from "./types.ts";

export interface FieldError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; lesson: Lesson } | { ok: false; errors: FieldError[] };

const FIELD_MESSAGES: Record<string, string> = {
  "/id": "The id must be a ULID: 26 characters of Crockford base32 (0-9, A-Z without I, L, O, U).",
  "/subject": "Write the subject in lowercase, like python or wrangler: letters, digits, dots, and dashes, up to 64 characters.",
  "/version": "Write the version as text, for example >=3.12, or leave it out.",
  "/kind": "Choose a kind: removed, added, changed, deprecated, or behaves, or leave it out.",
  "/claim": "Write one sentence of 10 to 400 characters.",
  "/evidence": "Give 1 to 3 pieces of evidence: a test or a source.",
  "/author": "The author must be github:<login> of the account that signed.",
  "/author_id": "The author_id must be the signer's numeric GitHub user id (a whole number, 1 or more).",
  "/replaces": "List the ids (ULIDs) of the lessons this one corrects.",
  "/created_at": "The time must be UTC in the form YYYY-MM-DDTHH:MM:SSZ.",
};

const EVIDENCE_MESSAGES: Record<string, string> = {
  run: 'A test needs "runner" (python, bash, node, or lean) and "code" (up to 8000 characters) that exits 0 only if the claim is true.',
  "run/runner": "Choose a runner: python, bash, node, or lean, or one pinned to a version, such as python@3.12 or node@22.",
  "run/expect": 'Set "expect" to "pass" (the default) or "fail".',
  "run/error": "Write the error as a sentence of 8 to 300 characters that the test's output must contain.",
  "run/code": "Test code must be text of at most 8000 characters that exits 0 only if the claim is true.",
  source: 'A source needs "url" and "quote".',
  "source/url": "The source URL must start with https://.",
  "source/quote": "Paste an exact sentence from the page: 8 to 300 characters.",
};

/** In the order of the claim's allOf in lessons.schema.json. */
const CLAIM_GUARDS = [
  "Remove invisible characters and line breaks: a claim is one line of plain text.",
  "Remove the link from the claim. Put it in a source, with a sentence quoted from the page.",
  "Remove the command line (a pipe into a shell, curl or wget into a pipe, rm -rf, or $(...)). Say what changed; runnable code goes in a test.",
  "Remove the instructions to an AI or to the reader. A claim states a fact about its subject.",
];

const SUBJECT_GUARD =
  "This subject can't be a directory or branch name: no '..', no '.' or '-' at the end, no '.lock' ending, and not con, prn, aux, nul, com0-9, or lpt0-9.";

const EVIDENCE_SHAPE = 'Each piece of evidence is either a test, {"run": {"runner", "code"}}, or a source, {"source": {"url", "quote"}}.';

/** Which oneOf branch an evidence item meant to be: 0 for run, 1 for source, undefined if unclear. */
function intendedBranch(item: unknown): number | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const keys = Object.keys(item);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "run") return 0;
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
    if (rest === "run" && err.keyword === "required" && err.params.missingProperty === "error") {
      return { path, message: 'A test with "expect": "fail" needs "error": a sentence its output must contain.' };
    }
    if (rest === "run" && err.keyword === "not") {
      return { path, message: '"error" goes only with "expect": "fail". Remove it, or set "expect": "fail".' };
    }
    if (rest === "run" && err.keyword === "if") return undefined;
    return { path, message: EVIDENCE_MESSAGES[rest] ?? EVIDENCE_SHAPE };
  }

  if (path === "/claim") {
    const guard = /^#\/properties\/claim\/allOf\/(\d)\//.exec(err.schemaPath)?.[1];
    if (guard !== undefined && CLAIM_GUARDS[Number(guard)]) return { path, message: CLAIM_GUARDS[Number(guard)]! };
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

/** Validates against the schema this code was built with (precompiled). */
export const validateLesson: LessonValidator = lessonValidator(generatedValidate);

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
