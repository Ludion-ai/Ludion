// Experiment 1: does an agent call ludion_ask by itself? Each question runs in two conditions, both with web
// search and Ludion available: (a) as is, (b) with one line in the folder's CLAUDE.md. Counts, per question,
// whether ludion_ask and WebSearch were called. Usage:
//   node tools/bench/src/e1.ts <questions.json> <out dir> [--cap-usd 25] [--model opus]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBatch, type Job } from "./batch.ts";

export const RULE_LINE = "For questions that involve versions or recent changes, use ludion_ask before answering.";

interface Question {
  id: string;
  library: string;
  question: string;
}

const [questionsPath, outDir] = process.argv.slice(2);
if (!questionsPath || !outDir) {
  console.error("Usage: node tools/bench/src/e1.ts <questions.json> <out dir> [--cap-usd 25] [--model opus]");
  process.exit(2);
}
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const capUsd = Number(flag("--cap-usd", "25"));
const model = flag("--model", "opus");
const questions = JSON.parse(readFileSync(questionsPath, "utf8")) as Question[];

const conditions = { a: undefined, b: RULE_LINE } as const;
const jobs: Job[] = Object.entries(conditions).flatMap(([name, claudeMd]) =>
  questions.map((q) => ({
    id: `${name}/${q.id}`,
    prompt: q.question,
    options: { condition: "ludion" as const, model, maxTurns: 8, maxBudgetUsd: 1, claudeMd },
    logPath: join(outDir, "runs", name, `${q.id}.jsonl`),
  })),
);

const startedAt = new Date().toISOString();
const result = await runBatch(jobs, { capUsd, spentUsd: 0, maxRuns: jobs.length, runs: 0 });

const rows = result.done.map(({ job, run }) => ({
  condition: job.id.split("/")[0]!,
  id: job.id.split("/")[1]!,
  asked: run.toolCalls.includes("mcp__ludion__ludion_ask"),
  searched: run.toolCalls.includes("WebSearch"),
  fetched: run.toolCalls.includes("WebFetch"),
  firstTool: run.toolCalls[0] ?? null,
  ludion: run.mcpServers.ludion ?? "missing",
  costUsd: run.costUsd,
  turns: run.turns,
  isError: run.isError,
}));
const rate = (c: string, key: "asked" | "searched") => {
  const r = rows.filter((x) => x.condition === c);
  return { n: r.length, yes: r.filter((x) => x[key]).length };
};
const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  model,
  capUsd,
  spentUsd: Number(result.budget.spentUsd.toFixed(4)),
  skipped: result.skipped.map((j) => j.id),
  ruleLine: RULE_LINE,
  asked: { a: rate("a", "asked"), b: rate("b", "asked") },
  searched: { a: rate("a", "searched"), b: rate("b", "searched") },
};
writeFileSync(join(outDir, "results.json"), JSON.stringify({ summary, rows: rows.sort((x, y) => (x.condition + x.id).localeCompare(y.condition + y.id)) }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
