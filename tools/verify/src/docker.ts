// Runs lesson test code in Docker with the network off (CLAUDE.md, "Lesson code runs only in Docker with the
// network off"). A test that pins package versions is run in two steps: first the packages are installed in a
// container with the network on, install scripts off, and no lesson code; then the lesson code runs in a fresh
// container with the network off, against those installed packages.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What to run: a format 0 runner (python, bash, node) or a format 1 runtime (node@24, python@3.12, …). */
export interface RunSpec {
  runtime: string;
  code: string;
  /** Exact package versions to install first (npm for node, pypi for python). */
  packages?: Record<string, string>;
}

export type RawRun =
  | { kind: "done"; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
  | { kind: "error"; reason: string };

export type RunFn = (spec: RunSpec) => Promise<RawRun>;

const TIMEOUT_MS = 30_000;
/** Tests that install packages usually start a tool (vitest, wrangler): give them longer. */
const TIMEOUT_WITH_PACKAGES_MS = 90_000;
const INSTALL_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 4000;

interface Image {
  image: string;
  command: string[];
  language: "node" | "python";
}

/** The image and command for a runner or runtime (docs/decisions.md, CI). Undefined if unknown. */
export function imageFor(runtime: string): Image | undefined {
  if (runtime === "python") return { image: "python:3.14-slim", command: ["python", "-"], language: "python" };
  if (runtime === "bash") return { image: "python:3.14-slim", command: ["bash", "-s"], language: "python" };
  if (runtime === "node") return { image: "node:24-slim", command: ["node", "-"], language: "node" };
  const m = /^(node|python)@(\d+(?:\.\d+)?)$/.exec(runtime);
  if (!m) return undefined;
  return m[1] === "node"
    ? { image: `node:${m[2]}-slim`, command: ["node", "-"], language: "node" }
    : { image: `python:${m[2]}-slim`, command: ["python", "-"], language: "python" };
}

/** Pull the images these runtimes need, before any timed run starts. Returns a message per image that failed. */
export function pullImages(runtimes: Iterable<string>): string[] {
  const failures: string[] = [];
  const images = new Set([...runtimes].map((r) => imageFor(r)?.image).filter((i): i is string => !!i));
  for (const image of images) {
    const r = spawnSync("docker", ["pull", "--quiet", image], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) failures.push(`Could not pull ${image}${r.error ? ` (${r.error.message})` : ""}.`);
  }
  return failures;
}

const LIMITS = ["--memory", "512m", "--cpus", "1", "--pids-limit", "128"];

/** Run as the host user where there is one (Linux, macOS), so files written into the work folder can be cleaned up. */
function userArgs(): string[] {
  return typeof process.getuid === "function" && typeof process.getgid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
}

/** `docker run` arguments for the lesson code: network off, read-only root, /tmp writable. Code on stdin. */
export function dockerArgs(runtime: string, name: string, workDir?: string): string[] {
  const img = imageFor(runtime);
  if (!img) throw new Error(`Unknown runtime ${runtime}.`);
  const mount = workDir
    ? [...userArgs(), "-v", `${workDir}:/w`, "-w", "/w", "-e", "HOME=/tmp", "-e", "NODE_PATH=/w/node_modules", "-e", "PYTHONPATH=/w/site", "-e", "LUDION_PACKAGES=/w"]
    : [];
  return ["run", "--rm", "-i", "--name", name, "--network", "none", ...LIMITS, "--read-only", "--tmpfs", "/tmp", ...mount, img.image, ...img.command];
}

/** `docker run` arguments for installing a test's packages: network on, no install scripts, no lesson code. */
export function installArgs(runtime: string, workDir: string, packages: Record<string, string>): string[] {
  const img = imageFor(runtime);
  if (!img) throw new Error(`Unknown runtime ${runtime}.`);
  const install =
    img.language === "node"
      ? ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]
      : ["pip", "install", "--no-cache-dir", "--only-binary", ":all:", "--target", "/w/site", ...Object.entries(packages).map(([n, v]) => `${n}==${v}`)];
  return ["run", "--rm", ...LIMITS, ...userArgs(), "-v", `${workDir}:/w`, "-w", "/w", "-e", "HOME=/w/.home", "-e", "npm_config_cache=/w/.npm", img.image, ...install];
}

function run(args: string[], stdin: string | undefined, timeoutMs: number, name?: string): Promise<RawRun> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (name) spawn("docker", ["kill", name], { stdio: "ignore" });
      else child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ kind: "error", reason: `Could not start Docker (${err.message}). Install Docker, or run without --run.` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ kind: "done", exitCode, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

export const runInDocker: RunFn = async (spec) => {
  const img = imageFor(spec.runtime);
  if (!img) return { kind: "error", reason: `Unknown runtime ${spec.runtime}. Use one from lessons/lessons.schema.json.` };
  const packages = spec.packages && Object.keys(spec.packages).length ? spec.packages : undefined;
  const name = `ludion-verify-${crypto.randomUUID()}`;
  if (!packages) return run(dockerArgs(spec.runtime, name), spec.code, TIMEOUT_MS, name);

  const workDir = mkdtempSync(join(tmpdir(), "ludion-test-"));
  try {
    if (img.language === "node") writeFileSync(join(workDir, "package.json"), JSON.stringify({ private: true, dependencies: packages }));
    const install = await run(installArgs(spec.runtime, workDir, packages), undefined, INSTALL_TIMEOUT_MS);
    if (install.kind === "error") return install;
    if (install.timedOut || install.exitCode !== 0) {
      const tail = (install.stderr || install.stdout).trim().slice(-OUTPUT_LIMIT);
      return { kind: "error", reason: `Could not install ${Object.entries(packages).map(([n, v]) => `${n}@${v}`).join(", ")}.${tail ? `\n${tail}` : ""}` };
    }
    return await run(dockerArgs(spec.runtime, name, workDir), spec.code, TIMEOUT_WITH_PACKAGES_MS, name);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

export type RunResult = { status: "passed" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

const tailOf = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(-OUTPUT_LIMIT);

/**
 * What a finished run means. expect pass: exit 0 passes, unless stdout has a line starting "skip:".
 * expect fail: it must exit non-zero, and its output must contain `error`, so it fails for the reason the lesson names.
 */
export function interpretRun(raw: RawRun, expect: "pass" | "fail" = "pass", error?: string): RunResult {
  if (raw.kind === "error") return { status: "failed", reason: raw.reason };
  if (raw.timedOut) return { status: "failed", reason: "The test ran too long (30 seconds, or 90 with packages). Make it finish faster and work offline." };
  if (expect === "fail") {
    if (raw.exitCode === 0) return { status: "failed", reason: `The test was expected to fail with "${error}", but it exited 0.` };
    const output = `${raw.stdout}\n${raw.stderr}`;
    if (error && output.includes(error)) return { status: "passed" };
    const tail = tailOf(raw);
    return { status: "failed", reason: `The test failed, but its output does not contain "${error}". It must fail for the reason the lesson names.${tail ? `\n${tail}` : ""}` };
  }
  if (raw.exitCode === 0) {
    const skip = raw.stdout.split(/\r?\n/).find((line) => line.startsWith("skip:"));
    return skip ? { status: "skipped", reason: skip } : { status: "passed" };
  }
  const tail = tailOf(raw);
  return { status: "failed", reason: `The test exited with code ${raw.exitCode}, so the fact did not hold.${tail ? `\n${tail}` : ""}` };
}
