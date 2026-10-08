---
paths:
  - "docs/bench/**/*"
  - "tools/bench/**/*"
---

# FreshBench

FreshBench measures whether Ludion helps an assistant answer questions about recent changes in software: the questions a model trained before the change answers with confidence and gets wrong. It is outside the write path, so it may call LLMs. Nothing it produces becomes a lesson unless a person signs it.

## Input: changelogs with dates and URLs

- A **library** is one package or tool with public release notes: GitHub releases, a `CHANGELOG.md` at a tag, or an official changelog page. Every entry used has a date and a URL.
- The **window** is the 90 days before the bench date. Entries outside it are not used.
- For each library, record its name, the changelog URLs, the window, and how many entries fall in it.

## Questions and their answers

1. From the window, pick entries a user would notice: something **removed**, **added**, **changed**, or **deprecated**, or a behavior a user is likely to get wrong. Skip refactors, docs-only changes, and dependency bumps.
2. For each entry, write one **change**: `{id, library, version, date, url, quote, answer}`. `quote` is an exact span of 8 to 300 characters from the page at `url`, and must pass `checkSource` (`packages/core`). `answer` is one sentence stating the current fact.
3. For each change, write two questions, **A** and **B**, the way a developer asks while working (a task, an error message, a "how do I"). Neither names the release that made the change or quotes the changelog. B asks about the same fact as A, in different words and from a different angle.
4. The answer key for both: `answer`, plus `accept` (what a correct answer must say) and `reject` (the stale answer a model is likely to give).
5. An LLM may draft changes and questions. Claude Code checks each one against its quote before it is used, and drops any question whose answer the quote does not settle.

v0: 3 libraries, 15 changes each, so 15 A questions and 15 B questions per library.

## Conditions

The same agent, model, and prompt in each condition. Only the tools differ.

| Condition | Tools |
| - | - |
| `none` | none |
| `web` | WebSearch and WebFetch |
| `ludion` | WebSearch, WebFetch, and Ludion (`https://ludion.ai/mcp`) |

- The agent is Claude Code run headless (`claude -p`) in a new empty folder, with a configuration that exists only for the run: only that condition's MCP server and tools, no user or project instructions, `--max-turns 10`. Record the CLI version and the model id.
- The prompt is the question, then: "Answer in a few sentences."

## Scoring

- A separate LLM call with no tools grades each answer against the question, the answer key, and the quote: **correct**, **wrong**, or **no answer**.
  - Correct: it states the current fact as the key's `accept` says, and doesn't also present the stale behavior as current.
  - Wrong: it states the stale behavior, or something else false, as current.
  - No answer: it declines or says it doesn't know. This does not count as correct.
- The score is correct answers / questions, in percent, per library and overall. Differences are in percentage points.
- Claude Code reads at least 10% of the grades, chosen at random, and reports every disagreement with the judge. The judge's prompt is saved with the results.

## Seeds stay out of the measurement

Seed lessons are drafted only from **A** questions the agent got wrong. Ludion is measured only on **B** questions. A lesson's claim never copies a B question's wording. So the bench measures whether Ludion helps with the same change asked in a new way, not whether it can recite the question it was taught from.

The value test (acceptance test 2 in CLAUDE.md) is `ludion` minus `web` on the B questions of the wedge library: +20 points or more passes; under +10 means the delivery or the seed lessons are wrong.

## Budget

- Before a run, write its limits in the run's `README.md`: the most agent runs, turns per run, and US dollars (summed from the `total_cost_usd` each headless run reports). v0 defaults: 300 agent runs, 10 turns each, USD 100 per bench run.
- Check the running total before each batch. When the next batch could cross a limit, stop and report instead of starting it.

## Results

In `docs/bench/<YYYY-MM-DD>/`:

- `README.md`: the libraries and why they were chosen, the window, limits, CLI version and model, and the score tables.
- `changes.json`, `questions.json`: the changes with quotes, and the A and B questions with answer keys.
- `runs/<condition>/<question id>.json`: each run's raw log, untrimmed.
- `grades.json` and `judge-prompt.md`.

Every number in a report comes from these files. The harness lives in `tools/bench/` (Node; Node-only APIs are allowed there).
