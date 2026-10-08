#!/usr/bin/env node
// npm run verify:pr -- [--json <path>]
// Run by verify.yml on every pull request. Reads the PR from $GITHUB_EVENT_PATH.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { BaseRunner, Lesson, LessonValidator } from "@ludion/core";
import { compileLessonSchema } from "./base-schema.ts";
import { pullImages, runInDocker } from "./docker.ts";
import { parseNameStatus, planChanges, verifyPullRequest, type PullRequestAuthor } from "./pr.ts";
import { countByStatus, labelsOf, printResults, stepSummary } from "./report.ts";
import { createSafeFetch } from "./safe-fetch.ts";
import type { LessonFile } from "./verify.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function baseLessons(baseRef: string, validate: LessonValidator): Lesson[] {
  const paths = git("ls-tree", "-r", "--name-only", baseRef, "--", "lessons/").split("\n").filter((p) => /^lessons\/[^/]+\/[^/]+\.json$/.test(p));
  const lessons: Lesson[] = [];
  for (const p of paths) {
    try {
      const v = validate(JSON.parse(git("show", `${baseRef}:${p}`)));
      if (v.ok) lessons.push(v.lesson);
    } catch {
      // A broken file on the base branch is not this PR's problem.
    }
  }
  return lessons;
}

function runnersIn(files: LessonFile[], validate: LessonValidator): Exclude<BaseRunner, "lean">[] {
  const runners = new Set<Exclude<BaseRunner, "lean">>();
  for (const f of files) {
    try {
      const v = validate(JSON.parse(f.text));
      if (!v.ok) continue;
      for (const e of v.lesson.evidence) {
        // Pinned runners are refused until step 8 (verify.ts), so they need no image yet.
        const r = "run" in e ? e.run.runner : undefined;
        if (r === "python" || r === "bash" || r === "node") runners.add(r);
      }
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
  // The rules come from the base branch, never from the PR: a PR cannot add its own bot or loosen the schema.
  const config = JSON.parse(git("show", `${baseRef}:ludion.config.json`)) as { app_bot_id?: number };
  const validate = compileLessonSchema(git("show", `${baseRef}:lessons/lessons.schema.json`));

  // Every file the PR changes, not only lessons/: a lesson PR may change nothing else.
  const plan = planChanges(parseNameStatus(git("diff", "--no-renames", "--name-status", `${baseRef}...HEAD`)));
  const added: LessonFile[] = plan.added.map((path) => ({ path, text: readFileSync(path, "utf8") }));

  const pullFailures = pullImages(runnersIn(added, validate));
  for (const f of pullFailures) console.error(f);

  const results = await verifyPullRequest(plan, added, {
    base: baseLessons(baseRef, validate),
    fetchFn: createSafeFetch(),
    run: runInDocker,
    validate,
    author,
    appBotId: config.app_bot_id,
    commitMessageFor: (path) => git("log", "--diff-filter=A", "--format=%B", "-n", "1", `${baseRef}..${headSha}`, "--", path) || null,
  });

  printResults(results);
  const labels = labelsOf(results);
  writeFileSync(values.json, JSON.stringify({ results, labels }, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary(results));
  return countByStatus(results).failed > 0 ? 1 : 0;
}

process.exitCode = await main();
