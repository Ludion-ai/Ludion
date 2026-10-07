import type { Evidence, Lesson } from "./types.ts";

function formatEvidence(e: Evidence): Evidence {
  if ("run" in e) return { run: { runner: e.run.runner, code: e.run.code } };
  return { source: { url: e.source.url, quote: e.source.quote } };
}

/** Canonical file contents: keys in spec order, absent optional fields omitted, 2-space indent, trailing newline. */
export function formatLesson(lesson: Lesson): string {
  const out: Record<string, unknown> = { id: lesson.id, subject: lesson.subject };
  if (lesson.version != null) out.version = lesson.version;
  out.claim = lesson.claim;
  out.evidence = lesson.evidence.map(formatEvidence);
  out.author = lesson.author;
  out.author_id = lesson.author_id;
  if (lesson.replaces != null) out.replaces = lesson.replaces;
  out.created_at = lesson.created_at;
  return JSON.stringify(out, null, 2) + "\n";
}
