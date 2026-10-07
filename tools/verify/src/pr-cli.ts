#!/usr/bin/env node
// npm run verify:pr -- [--json <path>]
// Run by verify.yml on every pull request. Reads the PR from $GITHUB_EVENT_PATH.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateLesson, type Lesson, type Runner } from "@ludion/core";
import { pullImages, runInDocker } from "./docker.ts";
import { parseNameStatus, planChanges, verifyPullRequest, type PullRequestAuthor } from "./pr.ts";
import { countByStatus, labelsOf, printResults, stepSummary } from "./report.ts";
import { createSafeFetch } from "./safe-fetch.ts";
import type { LessonFile } from "./verify.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function baseLessons(baseRef: string): Lesson[] {
  const paths = git("ls-tree", "-r", "--name-only", baseRef, "--", "lessons/").split("\n").filter((p) => /^lessons\/[^/]+\/[^/]+\.json$/.test(p));
  const lessons: Lesson[] = [];
  for (const p of paths) {
    try {
      const v = validateLesson(JSON.parse(git("show", `${baseRef}:${p}`)));
      if (v.ok) lessons.push(v.lesson);
    } catch {
      // A broken file on the base branch is not this PR's problem.
    }
  }
  return lessons;
}

function runnersIn(files: LessonFile[]): Exclude<Runner, "lean">[] {
  const runners = new Set<Exclude<Runner, "lean">>();
  for (const f of files) {
    try {
      const v = validateLesson(JSON.parse(f.text));
      if (!v.ok) continue;
      for (const e of v.lesson.evidence) if ("run" in e && e.run.runner !== "lean") runners.add(e.run.runner);
    } catch {
      // Reported when verified.
    }
  }
  return [...runners];
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { json: { type: "string", default: "results.json" } } });
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("GITHUB_EVENT_PATH is not set. verify:pr runs in GitHub Actions; locally, use npm run verify -- <files>.");
    return 2;
  }
  const pr = JSON.parse(readFileSync(eventPath, "utf8")).pull_request;
  if (!pr) {
    console.error("This event has no pull_request. Run verify:pr only on pull_request events.");
    return 2;
  }
  const baseRef = `origin/${pr.base.ref}`;
  const headSha: string = pr.head.sha;
  const author: PullRequestAuthor = { id: pr.user.id, login: pr.user.login, type: pr.user.type };
  const config = JSON.parse(readFileSync("ludion.config.json", "utf8")) as { app_bot?: string };

  const plan = planChanges(parseNameStatus(git("diff", "--no-renames", "--name-status", `${baseRef}...HEAD`, "--", "lessons/")));
  const added: LessonFile[] = plan.added.map((path) => ({ path, text: readFileSync(path, "utf8") }));

  const pullFailures = pullImages(runnersIn(added));
  for (const f of pullFailures) console.error(f);

  const results = await verifyPullRequest(plan, added, {
    base: baseLessons(baseRef),
    fetchFn: createSafeFetch(),
    run: runInDocker,
    author,
    appBot: config.app_bot,
    commitMessageFor: (path) => git("log", "--diff-filter=A", "--format=%B", "-n", "1", `${baseRef}..${headSha}`, "--", path) || null,
  });

  printResults(results);
  const labels = labelsOf(results);
  writeFileSync(values.json, JSON.stringify({ results, labels }, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary(results));
  return countByStatus(results).failed > 0 ? 1 : 0;
}

process.exitCode = await main();
