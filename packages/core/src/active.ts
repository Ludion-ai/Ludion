import type { Lesson } from "./types.ts";

/** All lessons minus every id that appears in some other lesson's `replaces`. */
export function activeSet<T extends Pick<Lesson, "id" | "replaces">>(lessons: T[]): T[] {
  const replaced = new Set<string>();
  for (const l of lessons) {
    for (const id of l.replaces ?? []) if (id !== l.id) replaced.add(id);
  }
  return lessons.filter((l) => !replaced.has(l.id));
}
