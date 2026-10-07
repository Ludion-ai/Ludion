import type { Lesson, VerifiedBy } from "./types.ts";

export function verifiedBy(lesson: Pick<Lesson, "evidence">): VerifiedBy {
  const runs = lesson.evidence.filter((e) => "run" in e);
  if (runs.some((e) => e.run.runner === "lean")) return "proof";
  if (runs.length > 0) return "test";
  return "source";
}
