import { spawn } from "node:child_process";
import type { Runner } from "@ludion/core";

export type RunResult = { status: "passed" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

export type RunFn = (runner: Exclude<Runner, "lean">, code: string) => Promise<RunResult>;

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4000;

const IMAGES: Record<Exclude<Runner, "lean">, { image: string; command: string[] }> = {
  python: { image: "python:3.12-slim", command: ["python", "-"] },
  bash: { image: "python:3.12-slim", command: ["bash", "-s"] },
  node: { image: "node:22-slim", command: ["node", "-"] },
};

/** `docker run` arguments for one piece of run evidence. The code arrives on stdin. */
export function dockerArgs(runner: Exclude<Runner, "lean">, name: string): string[] {
  const { image, command } = IMAGES[runner];
  return [
    "run", "--rm", "-i", "--name", name,
    "--network", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
    "--read-only", "--tmpfs", "/tmp",
    image, ...command,
  ];
}

/** Interpret a finished run: exit 0 passes, unless stdout has a line starting "skip:". */
export function interpretRun(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean): RunResult {
  if (timedOut) return { status: "failed", reason: "The test ran longer than 30 seconds. Make it finish faster and work offline." };
  if (exitCode === 0) {
    const skip = stdout.split(/\r?\n/).find((line) => line.startsWith("skip:"));
    return skip ? { status: "skipped", reason: skip } : { status: "passed" };
  }
  const tail = (stderr || stdout).trim().slice(-OUTPUT_LIMIT);
  return { status: "failed", reason: `The test exited with code ${exitCode}, so the claim did not hold.${tail ? `\n${tail}` : ""}` };
}

export const runInDocker: RunFn = (runner, code) =>
  new Promise((resolve) => {
    const name = `ludion-verify-${crypto.randomUUID()}`;
    const child = spawn("docker", dockerArgs(runner, name), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", name], { stdio: "ignore" });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "failed", reason: `Could not start Docker (${err.message}). Install Docker, or run without --run.` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(interpretRun(exitCode, stdout, stderr, timedOut));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(code);
  });
