// Runs many agent runs a few at a time, saving each run's raw log, and stops before a run that could cross the
// spending cap (docs/decisions.md, Bench).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runAgent, type AgentRun, type RunOptions } from "./agent.ts";

export interface Job {
  id: string;
  prompt: string;
  options: RunOptions;
  /** Where the raw stream-json log goes. */
  logPath: string;
}

export interface Budget {
  /** Total US dollars this batch may spend, counting what was spent before it. */
  capUsd: number;
  spentUsd: number;
  /** Most agent runs, counting earlier ones. */
  maxRuns: number;
  runs: number;
}

export interface BatchResult {
  done: { job: Job; run: AgentRun }[];
  /** Jobs not started because the next one could have crossed a limit. */
  skipped: Job[];
  budget: Budget;
}

export async function runBatch(jobs: Job[], budget: Budget, concurrency = 3): Promise<BatchResult> {
  const done: BatchResult["done"] = [];
  const skipped: Job[] = [];
  const queue = [...jobs];
  let stopped = false;

  async function worker(): Promise<void> {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // A run may spend up to its own --max-budget-usd; don't start one that could cross the cap.
      if (stopped || budget.runs >= budget.maxRuns || budget.spentUsd + job.options.maxBudgetUsd > budget.capUsd) {
        stopped = true;
        skipped.push(job);
        continue;
      }
      budget.runs++;
      const run = await runAgent(job.prompt, job.options);
      budget.spentUsd += run.costUsd;
      mkdirSync(dirname(job.logPath), { recursive: true });
      writeFileSync(job.logPath, run.log.join("\n") + "\n");
      done.push({ job, run });
      process.stdout.write(`${job.id} ${job.options.condition}: ${run.toolCalls.join(",") || "no tools"} $${run.costUsd.toFixed(3)} (total $${budget.spentUsd.toFixed(2)})\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { done, skipped, budget };
}
