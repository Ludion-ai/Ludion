import { validateLesson, type FieldError } from "./schema.ts";
import type { Evidence, Lesson } from "./types.ts";

/** A lesson before signing: no id, author, author_id, or created_at yet. */
export interface Draft {
  subject: string;
  version?: string | null;
  claim: string;
  evidence: Evidence[];
  replaces?: string[];
}

export type DraftResult = { ok: true; draft: Draft } | { ok: false; errors: FieldError[] };

const SIGNING_FIELDS = ["id", "author", "author_id", "created_at"] as const;
const PLACEHOLDER = { id: "00000000000000000000000000", author: "github:draft", author_id: 1, created_at: "2000-01-01T00:00:00Z" };

/** Validate a draft with the lesson schema, ignoring the four fields that signing adds (worker.md). */
export function validateDraft(data: unknown): DraftResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: [{ path: "/", message: "A draft must be a JSON object with subject, claim, and evidence." }] };
  }
  const given = data as Record<string, unknown>;
  const errors: FieldError[] = SIGNING_FIELDS.filter((f) => f in given).map((f) => ({
    path: `/${f}`,
    message: `Leave out "${f}"; Ludion sets it when the lesson is signed.`,
  }));
  const result = validateLesson({ ...given, ...PLACEHOLDER });
  if (!result.ok) errors.push(...result.errors.filter((e) => !SIGNING_FIELDS.some((f) => e.path === `/${f}`)));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: toDraft(given as unknown as Lesson) };
}

/** The draft's fields in canonical order, absent optional fields left out. */
export function toDraft(lesson: Draft): Draft {
  return {
    subject: lesson.subject,
    ...(lesson.version != null ? { version: lesson.version } : {}),
    claim: lesson.claim,
    evidence: lesson.evidence,
    ...(lesson.replaces != null ? { replaces: lesson.replaces } : {}),
  };
}
