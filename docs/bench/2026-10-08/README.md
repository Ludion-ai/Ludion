# FreshBench v0: 2026-10-08

The first FreshBench run, following the method proposed in #19 (`bench.md` there, never merged; the method is now in `docs/decisions.md`, Bench). One change's answer key here is known to be wrong (WebdriverIO, `vitest-5-0-0-6`, in both the A and B sets), so every vitest score and every overall score below includes one question graded against a wrong key. It is to be fixed against primary sources and the scores recomputed (`docs/progress.md`). The window is the 90 days before 2026-10-08: 2026-07-10 to 2026-10-08.

## Libraries, and why these three

Five candidates. Changelog entries in the window, after removing "Updated dependencies" bullets:

| Candidate | Releases in window | Changelog entries | Real changes | Source |
| - | - | - | - | - |
| wrangler | 47 (4.111.0 to 4.148.0) | 332 | 288 | `packages/wrangler/CHANGELOG.md` at `wrangler@4.148.0` |
| vitest | 5 stable (4.1.11, 5.0.0 to 5.0.3) | 298 | about 298 | GitHub releases v4.1.11 and v5.0.0 to v5.0.3 |
| agents (Cloudflare Agents SDK) | 12 (0.17.4 to 0.27.0) | 141 | 140 | `packages/agents/CHANGELOG.md` at `agents@0.27.0` |
| MCP TypeScript SDK v2 | 7 per package (2.0.0-beta.4 to 2.3.1) | 114 (server and client summed) | about 100, many in both | server and client `CHANGELOG.md` at 2.3.1 |
| @cloudflare/vitest-plugin | 47 | 84 | 37 | `packages/vitest-plugin/CHANGELOG.md` at 1.3.7 |

**Chosen: wrangler, vitest, agents**, the three with the most real changes in the window.
- vitest's count includes betas from before the window, because the 5.0.0 notes cover everything since 4.1.5. But 5.0.0 itself shipped in the window (2026-09-03), so those changes are new to anyone who learned from releases before it.
- The MCP SDK is next. Its server and client changelogs repeat each other, and 2.0.0 repeats its betas.
- vitest-plugin has few real changes: most of its releases only bump dependencies.

Dates are npm publish dates (`npm view <pkg> time`), because changesets changelogs have none.

## Method

- **Changes** (`changes.json`): 15 per library, picked as things a developer would notice (removed, added, changed, deprecated, or a behavior people get wrong); refactors, docs-only items, and dependency bumps were skipped. Each has a version, a date, a URL at a release tag, an exact quote, the current fact, and the stale answer.
  - All 45 quotes (and the 73 other candidates) pass `checkSource` from `packages/core` through the guarded fetch `tools/verify` uses.
  - Changes and quotes were collected by a Claude Code subagent. Claude Code wrote the questions and checked each against its change.
- **Questions** (`questions.json`): per change, an **A** question (the seed set) and a **B** question (the same fact asked differently). Each has the answer key: the fact, what a correct answer must say, and the stale answer to watch for.
- **Agent**: Claude Code 2.1.294 headless, model `claude-opus-5-5`, in a new empty folder with a configuration that exists only for the run (`tools/bench/src/agent.ts`). The prompt is the question plus "Answer in a few sentences."
  - `none`: no tools.
  - `web`: WebSearch and WebFetch.
  - Up to 10 turns; $0.50 per `none` run and $1.50 per `web` run at most.
- **Drafts in context**: the drafts are added to the system prompt, worded the way `ludion_ask` returns lessons. This measures the lessons with perfect delivery; whether the agent fetches them on its own is experiment 1's question.
- **Judge**: a separate Claude Code run (Opus 5.5, no tools, one turn) per answer, with the prompt in `judge-prompt.md`. Grades: correct, wrong, or no answer; no answer doesn't count as correct.
- **Limits set before the run**: 300 agent runs and USD 80 in total, judge included.

## Stage 1: the A questions, no tools and web search

Percent correct, per library (15 questions each):

| Library | A-none | A-web |
| - | - | - |
| wrangler | 0% (0/15; wrong 14, no answer 1) | 40% (6/15; wrong 9, no answer 0) |
| agents | 13% (2/15; wrong 9, no answer 4) | 73% (11/15; wrong 4, no answer 0) |
| vitest | 7% (1/15; wrong 14, no answer 0) | 27% (4/15; wrong 11, no answer 0) |
| all | 7% (3/45; wrong 37, no answer 5) | 47% (21/45; wrong 24, no answer 0) |

- With no tools, the agent answers almost every question from older knowledge, and confidently: 37 of 45 are wrong rather than "I don't know".
- Web search lifts it to 47% overall. wrangler and vitest stay under half: the changes are in changelogs and release notes that search doesn't surface, or that the agent doesn't trust over its own knowledge.
- **The library that failed most: vitest** (27% with web search, 7% without).
- One no-tools run (`agents-0-22-0-11-a`, about `useAgentChat` throttling) hung twice and was killed at the 10-minute limit; it counts as no answer. Two others that hung on the first try were rerun with the same settings (`answers-A-none-rerun.json`). One judge reply was first misread by the grade parser (braces inside its explanation); the parser was fixed and every grade re-read from the saved judge logs, which changed only that one (it was correct).

## Stage 2: ten drafts, and the same changes asked differently

From the vitest A questions answered wrong with web search, Claude Code drafted ten lessons (`drafts.json`). Each is one claim with source evidence only: the change's release-note quote, already confirmed by `checkSource`. All ten pass the lesson schema with #19's fields (`kind`) and #21's claim guards. They are **not lessons**: not in `lessons/`, not signed, not served.

Then the ten **B** questions for those changes (the same fact asked differently, never the A wording):

| Library | B-none | B-web | B-none-drafts | B-web-drafts |
| - | - | - | - | - |
| vitest | 20% (2/10; wrong 8, no answer 0) | 40% (4/10; wrong 6, no answer 0) | 100% (10/10; wrong 0, no answer 0) | 100% (10/10; wrong 0, no answer 0) |
| all | 20% (2/10; wrong 8, no answer 0) | 40% (4/10; wrong 6, no answer 0) | 100% (10/10; wrong 0, no answer 0) | 100% (10/10; wrong 0, no answer 0) |

| B question | none | web | none + drafts | web + drafts |
| - | - | - | - | - |
| My getByText('Save') locator no longer matches a 'Save changes' button in Vitest. Why? | wrong | correct | correct | correct |
| What separator does Vitest's testNamePattern use between suite and test names? | wrong | correct | correct | correct |
| Do I need extends: true for each inline project to pick up my root Vitest settings? | wrong | wrong | correct | correct |
| Vitest throws when I call vi.mock inside beforeEach. Why? | correct | correct | correct | correct |
| Does Vitest have something like jest-when for argument-based mock results? | wrong | wrong | correct | correct |
| How does vitest list find tests without executing them? | wrong | wrong | correct | correct |
| I run vitest inside packages/foo and it ignores the root config. Is that expected? | correct | correct | correct | correct |
| Which browser providers can Vitest browser mode use? | wrong | wrong | correct | correct |
| How do I check that an element's text contains a phrase in Vitest browser mode? | wrong | wrong | correct | correct |
| Which folder does vitest --merge-reports read from by default? | wrong | wrong | correct | correct |

- With the drafts in context, the agent answered all ten correctly, with or without web search: **+60 points over web search** (40% → 100%) and +80 over no tools.
- **This is the ceiling, not the value test.**
  - The drafts were placed in the context, so delivery was perfect. In experiment 1 the agent called `ludion_ask` in every run, but the search still has to find the right lesson for each B question.
  - The drafts were written from the same changes the B questions ask about, and the judge's key states the same fact. B never reuses A's wording, but the lesson does contain the answer.
  - Ten questions, one library, one model, one day.
- The value test (acceptance test 2) has to run the `ludion` condition against production, with the lessons merged and served by search.

## Spot checks

Claude Code read 13 grades chosen at random: 9 of the 90 in stage 1 and 4 of the 40 in stage 2, at least 10% of each. It agreed with the judge on all 13.

## Cost and limits

$8.40 of the $80 cap in 267 Claude Code runs:
- 90 stage 1 answers and their 90 grades;
- 3 reruns, their 3 grades, and 1 re-judge;
- 40 stage 2 answers and their 40 grades.

Most runs were no-tools; web runs cost $0.03 to $0.15 each. Nothing was skipped for budget.

## Files

- `changes.json`: the 45 changes, each with version, date, URL, quote, fact, stale answer, and the `checkSource` result.
- `questions.json`: 90 questions (45 A, 45 B) with answer keys.
- `answers-<label>.json`, `grades-<label>.json`: per condition. Labels:
  - `A-none`, `A-web`;
  - `B-none`, `B-web`, `B-none-drafts`, `B-web-drafts`;
  - the rerun and re-judge files, kept for the record.
- `drafts.json`: the ten drafts.
- `judge-prompt.md`: the judge's prompt.
- `runs/<label>/*.jsonl`: every run's raw log, judge runs included (`runs/judge-<label>/`). Local paths and the account name are replaced with `~` and `user`.

To run it again: `node tools/bench/src/freshbench.ts run docs/bench/2026-10-08/questions.json <out dir> <label> --set A --condition web --cap-usd 80`, then `node tools/bench/src/freshbench.ts judge … <label>`. Stage 2 adds `--set B --only <ids> --context docs/bench/2026-10-08/drafts.json`.
