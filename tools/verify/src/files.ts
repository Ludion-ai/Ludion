import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { validateLesson, type Lesson } from "@ludion/core";
import type { LessonFile } from "./verify.ts";

const NOT_LESSONS = new Set(["lessons.schema.json", "lessons-v0.schema.json"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".json") && !NOT_LESSONS.has(entry.name)) out.push(full);
  }
}

/** Expand files and directories into lesson files, sorted, paths relative to `root` with forward slashes. */
export function collectLessonFiles(args: string[], root: string): LessonFile[] {
  const paths: string[] = [];
  for (const arg of args) {
    const full = join(root, arg);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      throw new Error(`${arg} does not exist. Pass lesson files or directories, for example: npm run verify -- lessons/`);
    }
    if (isDir) walk(full, paths);
    else paths.push(full);
  }
  return [...new Set(paths)].sort().map((p) => ({
    path: relative(root, p).split(sep).join("/"),
    text: readFileSync(p, "utf8"),
  }));
}

/** Every valid lesson under `<root>/lessons`, for the active set. Invalid files are skipped here; verify reports them. */
export function loadBaseLessons(root: string): Lesson[] {
  const files: string[] = [];
  try {
    walk(join(root, "lessons"), files);
  } catch {
    return [];
  }
  const lessons: Lesson[] = [];
  for (const f of files) {
    try {
      const v = validateLesson(JSON.parse(readFileSync(f, "utf8")));
      if (v.ok) lessons.push(v.lesson);
    } catch {
      // Not JSON; reported when verified.
    }
  }
  return lessons;
}
