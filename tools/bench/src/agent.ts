// Runs one question through Claude Code headless (`claude -p`) in a new empty folder, with a configuration that
// exists only for the run (bench.md, Conditions), and returns what it said and which tools it called.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Condition = "none" | "web" | "ludion";

export interface AgentRun {
  condition: Condition;
  model: string;
  /** Text of the final answer. */
  answer: string;
  /** Every tool the agent called, in order, by name (WebSearch, WebFetch, mcp__ludion__ludion_ask, ...). */
  toolCalls: string[];
  /** MCP servers as the session reported them at start: name → status. */
  mcpServers: Record<string, string>;
  costUsd: number;
  turns: number;
  isError: boolean;
  /** The raw stream-json lines, kept as the run's log. */
  log: string[];
}

export interface RunOptions {
  condition: Condition;
  model: string;
  maxTurns: number;
  /** Per-run spending cap passed to --max-budget-usd. */
  maxBudgetUsd: number;
  /** Text for a CLAUDE.md in the run's folder, or none. */
  claudeMd?: string;
  /** Text appended to the system prompt (for example lesson drafts given as context). */
  appendSystemPrompt?: string;
  ludionUrl?: string;
  /** Kill the run after this long. Default 10 minutes. */
  timeoutMs?: number;
}

const WEB_TOOLS = ["WebSearch", "WebFetch"];

/** The command-line arguments for one condition. Exported for tests. */
export function claudeArgs(prompt: string, o: RunOptions, mcpConfigPath?: string): string[] {
  const tools = o.condition === "none" ? [] : WEB_TOOLS;
  const allowed = o.condition === "ludion" ? [...WEB_TOOLS, "mcp__ludion__ludion_ask"] : tools;
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--max-turns", String(o.maxTurns),
    "--max-budget-usd", String(o.maxBudgetUsd),
    "--no-session-persistence",
    // Only this folder's settings (there are none): no user settings, plugins, hooks, or MCP servers.
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--tools", tools.length ? tools.join(",") : "",
  ];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  return args;
}

/** Pull the answer, tool calls, MCP status, cost, and turns out of stream-json lines. Exported for tests. */
export function parseStream(lines: string[]): Omit<AgentRun, "condition" | "model" | "log"> {
  // An error until a result line says otherwise: a run killed or cut short never prints one.
  const out = { answer: "", toolCalls: [] as string[], mcpServers: {} as Record<string, string>, costUsd: 0, turns: 0, isError: true };
  for (const line of lines) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init") {
      for (const s of m.mcp_servers ?? []) out.mcpServers[s.name] = s.status;
    }
    if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) {
        if (c.type === "tool_use" || c.type === "server_tool_use") out.toolCalls.push(c.name);
      }
    }
    if (m.type === "result") {
      out.answer = typeof m.result === "string" ? m.result : "";
      out.costUsd = Number(m.total_cost_usd ?? 0);
      out.turns = Number(m.num_turns ?? 0);
      out.isError = Boolean(m.is_error) || m.subtype !== "success";
    }
  }
  return out;
}

export function runAgent(prompt: string, o: RunOptions): Promise<AgentRun> {
  const dir = mkdtempSync(join(tmpdir(), "ludion-bench-"));
  const work = join(dir, "work");
  mkdirSync(work);
  if (o.claudeMd) writeFileSync(join(work, "CLAUDE.md"), o.claudeMd + "\n");
  let mcpConfigPath: string | undefined;
  if (o.condition === "ludion") {
    mcpConfigPath = join(dir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { ludion: { type: "http", url: o.ludionUrl ?? "https://ludion.ai/mcp" } } }));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("claude", claudeArgs(prompt, o, mcpConfigPath), { cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // A run that hangs (seen under rate limiting) is killed and counted as an error, so the batch moves on.
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 10 * 60_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const log = stdout.split(/\r?\n/).filter(Boolean);
      if (log.length === 0) return reject(new Error(`claude printed nothing. stderr: ${stderr.slice(0, 500)}`));
      resolve({ condition: o.condition, model: o.model, ...parseStream(log), log });
    });
  });
}
