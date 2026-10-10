# Progress

What was built, what the check showed, what was decided and why. Newest first. Numbers come from `docs/bench/`.

## Done when (CLAUDE.md)

| | Check | State |
| - | - | - |
| 1 | Single player: a lesson taught in project A shows up via `ludion sync` in project B, and Claude Code in B gets right the task it got wrong before | not started |
| 2 | Plumbing: `ludion teach --public` → merge → within five minutes `ludion sync` elsewhere writes it with the teacher's name, and `ludion_ask` returns it | not started |
| 3 | Value: FreshBench on the wedge, Claude Code with default tools in a project with the new version installed, with vs without `ludion sync`: +20 points | not started |

## Log

### 2026-10-11: Lesson format 1 (PR open)

- Built: format 1 schema (structured fields, generated claim, grounded `detail`, `signal`, pinned and differential tests), the frozen format 0 schema for old lessons, `generateClaim`, the grounding and symbol checks in `verify`, and two-step Docker runs for tests that pin packages. The leftovers of #13 are gone.
- Check: 231 tests pass, including new ones for every field rule, the security guard on `symbol`, the differential label, and the runner's commands. Docker isn't installed on the machine that built it, so the first real run of a pinned test happens in CI with the first format 1 lesson.

### 2026-10-11: Switched to spec v2

- CLAUDE.md replaced by the v2 spec; `.claude/rules/` deleted; their standing details moved to `docs/decisions.md`.
- Closed #13 and #23; #19, #20, and #21 are folded into the v2 work (see `docs/decisions.md`).
- Before v2, measured on 2026-10-08: FreshBench v0 A questions, 7% correct with no tools and 47% with web search; vitest's ten B questions, 40% with web search and 100% with lesson drafts in the context (`docs/bench/2026-10-08/`). Caveat: one answer key (WebdriverIO, `vitest-5-0-0-6`) is known to be wrong, and it is in both the A and B sets, so the 7%/47% overall, vitest's A scores, and the ten B scores all include it. It is to be fixed against primary sources and the scores recomputed. Experiment 1: `ludion_ask` called in 20/20 runs (`docs/experiments/e1/`).
