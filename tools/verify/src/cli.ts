#!/usr/bin/env node
// npm run verify -- <files or dirs> [--run] [--json <path>]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runInDocker } from "./docker.ts";
import { collectLessonFiles, loadBaseLessons } from "./files.ts";
import { summaryLine, verifyLesson, type LessonResult } from "./verify.ts";

const USAGE = "Usage: npm run verify -- <lesson files or directories> [--run] [--json <path>]";
const CONCURRENCY = 4;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { run: { type: "boolean", default: false }, json: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }

  const root = process.cwd();
  let files;
  try {
    files = collectLessonFiles(positionals, root);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (files.length === 0) {
    console.error(`No lesson files found in ${positionals.join(", ")}.`);
    return 2;
  }

  const ctx = { base: loadBaseLessons(root), fetchFn: fetch, run: values.run ? runInDocker : undefined };
  const results: LessonResult[] = new Array(files.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        results[i] = await verifyLesson(files[i]!, ctx);
      }
    }),
  );

  for (const r of results) {
    console.log(summaryLine(r));
    if (r.status !== "passed") for (const reason of r.reasons) console.log(`  ${reason.replace(/\n/g, "\n  ")}`);
  }
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped.`);
  if (!values.run && results.some((r) => r.status !== "failed")) {
    console.log("Test code was not run here. CI runs it in an isolated container (--run).");
  }
  if (values.json) writeFileSync(values.json, JSON.stringify({ results }, null, 2) + "\n");
  return count("failed") > 0 ? 1 : 0;
}

process.exitCode = await main();
