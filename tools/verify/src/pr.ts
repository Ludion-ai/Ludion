import { storedLogin, validateLesson, type Lesson } from "@ludion/core";
import { verifyLesson, type LessonFile, type LessonResult, type VerifyContext } from "./verify.ts";

export interface Change {
  /** git's --name-status letter: A, D, M, T, ... */
  status: string;
  path: string;
}

export interface PullRequestAuthor {
  id: number;
  login: string;
  /** "User" or "Bot" */
  type: string;
}

export interface ChangePlan {
  added: string[];
  deleted: string[];
  problems: { path: string; reason: string }[];
}

const LESSON_PATH = /^lessons\/[^/]+\/[^/]+\.json$/;
/** The schemas: format 1 for new lessons, and format 0 frozen for the lessons already on main. */
const SCHEMA_PATHS = new Set(["lessons/lessons.schema.json", "lessons/lessons-v0.schema.json"]);
export const IMMUTABLE = "Lessons are immutable. Add a new lesson that replaces this one instead.";
export const LESSON_FILES_ONLY = "A lesson pull request can change only lesson files in lessons/.";
export const STRAY_FILE = "Only lesson files go in lessons/<subject>/.";

/** Parse `git diff --no-renames --name-status` output. */
export function parseNameStatus(output: string): Change[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status.charAt(0), path };
    });
}

/**
 * Plan from every file the PR changes. A PR that adds or deletes lessons is a lesson PR and may change nothing else,
 * not even the schema. A PR that touches no lesson file is a code PR: nothing to verify here (`test` covers it).
 */
export function planChanges(changes: Change[]): ChangePlan {
  const plan: ChangePlan = { added: [], deleted: [], problems: [] };
  const lessonChanges = changes.filter((c) => LESSON_PATH.test(c.path));
  if (lessonChanges.length === 0) {
    for (const { path } of changes) {
      if (path.startsWith("lessons/") && !SCHEMA_PATHS.has(path)) plan.problems.push({ path, reason: STRAY_FILE });
    }
    return plan;
  }
  for (const { status, path } of lessonChanges) {
    if (status === "A") plan.added.push(path);
    else if (status === "D") plan.deleted.push(path);
    else plan.problems.push({ path, reason: IMMUTABLE });
  }
  for (const { path } of changes) {
    if (!LESSON_PATH.test(path)) plan.problems.push({ path, reason: LESSON_FILES_ONLY });
  }
  return plan;
}

const TRAILER = /^Taught-by: ([A-Za-z0-9-]{1,39}) \((\d+)\)[ \t]*$/m;

/**
 * Why this lesson may not come from this PR's author, or undefined. Identity is the numeric id,
 * for the teacher and for the App's bot account alike.
 */
export function authorProblem(lesson: Lesson, author: PullRequestAuthor, appBotId: number | undefined, commitMessage: string | null): string | undefined {
  if (author.type === "Bot") {
    if (appBotId === undefined || author.id !== appBotId) {
      return `This pull request was opened by ${author.login} (${author.id}), which is not the Ludion App. Lessons come from the person who signed them or from the Ludion App.`;
    }
    const m = commitMessage ? TRAILER.exec(commitMessage) : null;
    if (!m) return 'The commit that adds this lesson has no "Taught-by: <login> (<user id>)" trailer.';
    const [, login, id] = m;
    if (Number(id) !== lesson.author_id || login!.toLowerCase() !== storedLogin(lesson.author).toLowerCase()) {
      return `The commit says "Taught-by: ${login} (${id})", but the lesson's author is ${lesson.author} (${lesson.author_id}). They must match.`;
    }
    return undefined;
  }
  if (lesson.author_id !== author.id) {
    return `This lesson's author_id is ${lesson.author_id}, but the pull request was opened by @${author.login} (${author.id}). Teach lessons in your own name.`;
  }
  return undefined;
}

export interface PullRequestContext extends VerifyContext {
  author: PullRequestAuthor;
  /** `app_bot_id` from ludion.config.json on the base branch. */
  appBotId?: number;
  /** Message of the PR commit that added this path, or null. */
  commitMessageFor: (path: string) => string | null;
}

export async function verifyPullRequest(plan: ChangePlan, addedFiles: LessonFile[], ctx: PullRequestContext): Promise<LessonResult[]> {
  const results: LessonResult[] = plan.problems.map(({ path, reason }) => ({
    file: path, id: null, claim: null, status: "failed", reasons: [reason], labels: [],
  }));
  for (const path of plan.deleted) {
    const id = path.split("/").pop()!.replace(/\.json$/, "");
    results.push({ file: path, id, claim: null, status: "passed", reasons: [], labels: ["retract"] });
  }
  const validate = ctx.validate ?? validateLesson;
  for (const file of addedFiles) {
    const result = await verifyLesson(file, ctx);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      parsed = undefined;
    }
    const valid = validate(parsed);
    if (valid.ok) {
      const problem = authorProblem(valid.lesson, ctx.author, ctx.appBotId, ctx.commitMessageFor(file.path));
      if (problem) {
        result.status = "failed";
        result.reasons.push(problem);
      }
    }
    results.push(result);
  }
  return results;
}
