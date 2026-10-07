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

const SCHEMA_PATH = "lessons/lessons.schema.json";
const LESSON_PATH = /^lessons\/[^/]+\/[^/]+\.json$/;
export const IMMUTABLE = "Lessons are immutable. Add a new lesson that replaces this one instead.";

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

export function planChanges(changes: Change[]): ChangePlan {
  const plan: ChangePlan = { added: [], deleted: [], problems: [] };
  for (const { status, path } of changes) {
    if (path === SCHEMA_PATH) continue;
    if (!LESSON_PATH.test(path)) plan.problems.push({ path, reason: "Only lesson files go in lessons/<subject>/." });
    else if (status === "A") plan.added.push(path);
    else if (status === "D") plan.deleted.push(path);
    else plan.problems.push({ path, reason: IMMUTABLE });
  }
  return plan;
}

const TRAILER = /^Taught-by: ([A-Za-z0-9-]{1,39}) \((\d+)\)[ \t]*$/m;

/** Why this lesson may not come from this PR's author, or undefined. Identity is the numeric id. */
export function authorProblem(lesson: Lesson, author: PullRequestAuthor, appBot: string | undefined, commitMessage: string | null): string | undefined {
  if (author.type === "Bot") {
    if (!appBot || author.login !== appBot) {
      return `This pull request was opened by ${author.login}, which is not the Ludion App. Lessons come from the person who signed them or from the Ludion App.`;
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
  appBot?: string;
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
  for (const file of addedFiles) {
    const result = await verifyLesson(file, ctx);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      parsed = undefined;
    }
    const valid = validateLesson(parsed);
    if (valid.ok) {
      const problem = authorProblem(valid.lesson, ctx.author, ctx.appBot, ctx.commitMessageFor(file.path));
      if (problem) {
        result.status = "failed";
        result.reasons.push(problem);
      }
    }
    results.push(result);
  }
  return results;
}
