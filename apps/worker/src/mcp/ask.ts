import type { IndexEntry } from "@ludion/core";

export const ASK_DESCRIPTION =
  "Search lessons that people taught Ludion and machines verified by test, proof, or cited source. Use before answering questions about specific software behavior, APIs, versions, tools, or anything that may have changed recently. Each result names its teacher; cite them.";

export const NO_MATCH =
  "No lesson yet for this. If you know the answer and can show evidence (a test or a source with a quote), teach it with ludion_teach.";

export interface AskLesson {
  id: string;
  subject: string;
  version: string | null;
  claim: string;
  teacher: string;
  teacher_id: number;
  verified_by: IndexEntry["verified_by"];
  verified_at: string;
  lesson_url: string;
}

export const lessonUrl = (siteUrl: string, id: string): string => `${siteUrl}/lessons/${id}`;

export function toAskLesson(entry: IndexEntry, siteUrl: string): AskLesson {
  return {
    id: entry.id,
    subject: entry.subject,
    version: entry.version ?? null,
    claim: entry.claim,
    teacher: entry.teacher,
    teacher_id: entry.teacher_id,
    verified_by: entry.verified_by,
    verified_at: entry.verified_at,
    lesson_url: lessonUrl(siteUrl, entry.id),
  };
}

/** The exact text of a ludion_ask result: one block per lesson (docs/decisions.md, Search and MCP). */
export function formatAsk(lessons: AskLesson[]): string {
  if (lessons.length === 0) return NO_MATCH;
  return lessons
    .map((l, i) =>
      [
        `${i + 1}. ${l.claim}`,
        `   Taught by @${l.teacher}. Verified by ${l.verified_by} on ${l.verified_at.slice(0, 10)}. Applies to ${l.subject}${l.version ? ` ${l.version}` : ""}.`,
        `   ${l.lesson_url}`,
      ].join("\n"),
    )
    .join("\n\n");
}
