# Experiment 1: does an assistant call ludion_ask by itself?

Run on 2026-10-08, 12:08 to 12:16 UTC, against production (`https://ludion.ai/mcp`). Production holds one lesson (distutils), so every answer here was the no-match text; the experiment measures whether the agent **calls** `ludion_ask`, not what it gets back.

## Setup

- Agent: Claude Code 2.1.294, headless (`claude -p`), model `claude-opus-5-5` (`--model opus`). Harness: `tools/bench/src/e1.ts`.
- Each run gets a new, empty folder and a configuration that exists only for that run: `--setting-sources project` (the folder has no settings, so no user settings, plugins, or hooks), `--strict-mcp-config` with only Ludion's MCP server, `--tools WebSearch,WebFetch`, allowed tools WebSearch, WebFetch and `mcp__ludion__ludion_ask`, `--max-turns 8`, `--max-budget-usd 1`, `--no-session-persistence`.
- 20 questions (`questions.json`): four each about wrangler, the Cloudflare agents SDK, `@cloudflare/vitest-plugin`, the MCP TypeScript SDK v2, and vitest. Each is about a change from the 90 days before 2026-10-08 that a model is likely to answer from older knowledge. Each question records the change it is about (version, date, URL).
- Conditions:
  - **(a)** as is.
  - **(b)** the folder's `CLAUDE.md` has one line: "For questions that involve versions or recent changes, use ludion_ask before answering."
- Counted per run: did it call `ludion_ask`, did it call WebSearch (from the `tool_use` blocks in each run's log).
- Limits set before the run: 40 runs, 8 turns each, USD 25 in total.

## Results

| | (a) as is | (b) one CLAUDE.md line |
| - | - | - |
| Called ludion_ask | 20/20 (100%) | 20/20 (100%) |
| Called WebSearch | 13/20 (65%) | 16/20 (80%) |
| First tool called | ludion_ask 20, WebSearch 0, WebFetch 0, none 0 | ludion_ask 20, WebSearch 0, WebFetch 0, none 0 |
| Cost (USD) | 1.62 | 1.77 |

Spent $3.3897 of the $25 cap. Skipped: none. Ludion server not connected in: no run.

| # | Library | Question | (a) ask | (a) search | (b) ask | (b) search |
| - | - | - | - | - | - | - |
| q01 | wrangler | My wrangler config has no compatibility_date. What date does Wrangler use for my Worker? | yes | yes | yes | yes |
| q02 | wrangler | Do I need to add nodejs_compat to compatibility_flags to use node:crypto in a new Cloudflare Worker? | yes | no | yes | yes |
| q03 | wrangler | How do I log in to wrangler inside a dev container where the localhost callback can't be reached? | yes | no | yes | yes |
| q04 | wrangler | How do I serve my Workers static assets under /docs without moving the files on disk? | yes | yes | yes | yes |
| q05 | agents | How do I scaffold a new Cloudflare agent project with npx agents init? | yes | yes | yes | yes |
| q06 | agents | In the Cloudflare Agents SDK, how do I turn off WebSocket hibernation for my agent? | yes | yes | yes | yes |
| q07 | agents | Is this.getQueue() in a Cloudflare Agent synchronous, and what fields does a QueueItem have? | yes | no | yes | no |
| q08 | agents | How do I stop AIChatAgent from resuming interrupted chats? Does chatRecovery: false work? | yes | yes | yes | yes |
| q09 | @cloudflare/vitest-plugin | How do I set up @cloudflare/vitest-pool-workers in a new project's vitest.config.ts? | yes | yes | yes | yes |
| q10 | @cloudflare/vitest-plugin | How do I mock outbound fetch in Cloudflare Workers Vitest tests with fetchMock? | yes | yes | yes | yes |
| q11 | @cloudflare/vitest-plugin | Can I use MSW to mock requests in Cloudflare Workers Vitest tests, and which version do I need? | yes | yes | yes | yes |
| q12 | @cloudflare/vitest-plugin | How do I silence the verbose workerd logs when I run Vitest for my Worker? | yes | yes | yes | yes |
| q13 | MCP TypeScript SDK (v2) | Can I reuse one McpServer instance across requests in a stateless Streamable HTTP server with the MCP TypeScript SDK? | yes | yes | yes | yes |
| q14 | MCP TypeScript SDK (v2) | What is the largest request body the MCP TypeScript SDK's Streamable HTTP server accepts? | yes | yes | yes | yes |
| q15 | MCP TypeScript SDK (v2) | Is the MCP TypeScript SDK ESM-only, or can I require('@modelcontextprotocol/server')? | yes | no | yes | no |
| q16 | MCP TypeScript SDK (v2) | Does the MCP TypeScript SDK's HTTP client follow redirects to a different host? | yes | yes | yes | yes |
| q17 | vitest | What Node.js version does the latest Vitest require? | yes | no | yes | yes |
| q18 | vitest | How do I make the tests in a describe block run one after another with Vitest's sequential option? | yes | no | yes | no |
| q19 | vitest | Does Vitest clear mock call history between tests by default? | yes | yes | yes | yes |
| q20 | vitest | Where does Vitest's junit reporter write its file by default? | yes | no | yes | no |

## Decision, by the rule set before the run

The rule:
- (a) at 50% or more: the read path stays `ludion_ask`.
- (a) under 50% and (b) at 80% or more: a one-line rule, and no CLI.
- Both low: match errors in a PostToolUseFailure hook.

**(a) is 100% (20/20), so the read path stays `ludion_ask`** through the MCP server's instructions and the tool's description, with nothing more. In every run of both conditions, `ludion_ask` was the first tool called, before any web search. The CLAUDE.md line added web searches (65% to 80% of runs) but no `ludion_ask` calls, because there were none left to add.

## What this does not show

- **The setting makes calling easy.** The agent had three tools (WebSearch, WebFetch, `ludion_ask`), and each question was plainly about a library version. In a coding session with Bash, file tools, other MCP servers, and a task in progress, the rate could be lower. A follow-up with Claude Code's default tools, on questions that come up mid-task (an error after an upgrade), would test that.
- **One agent, one model, one day:** Claude Code with Opus 5.5. Other clients and models may behave differently.
- **Calling is not helping.** Every call returned the no-match text, because production has one lesson. Whether the lessons improve answers is FreshBench's question (`docs/bench/`).

## Files

- `questions.json`: the 20 questions, each with the change it is about.
- `results.json`: the summary and one row per run (called ludion_ask, called WebSearch or WebFetch, first tool, MCP status, cost, turns).
- `runs/a/*.jsonl`, `runs/b/*.jsonl`: each run's raw stream-json log. Local paths and the account name are replaced with `~` and `user`.

To run it again: `node tools/bench/src/e1.ts docs/experiments/e1/questions.json <out dir> --cap-usd 25 --model opus`.
