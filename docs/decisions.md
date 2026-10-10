# Decisions

CLAUDE.md is the spec. This file holds the details it leaves to us: what was decided, and why. Newest decisions go at the top of their section. When a decision changes, edit it here in the same PR as the code, and say what it replaced.

## v2 decisions

### 2026-10-11: Switching to spec v2

- CLAUDE.md is the v2 spec, word for word. `.claude/rules/` is deleted. What those files said about the system as it runs today is kept below under "Carried over from v0"; what v2 changes is recorded here as the work happens.
- **PRs from before v2.** #13 (server-side teaching: GitHub App, OAuth, sessions, `/api/teach`, `/teach`) is closed unmerged: teaching moves to the teacher's machine. #23 (read path = `ludion_ask` alone) is closed: v2's read path is `ludion sync`. The useful parts of #19, #20, and #21 are folded into the v2 work and those PRs are closed when the work that carries them is open:
  - from #19: optional `kind`, runners pinned to versions, `expect: fail` + `error` (the basis of lesson format v1), and the FreshBench method (A/B questions, seeds kept out of the measurement, an LLM judge with spot checks, budgets).
  - from #20: deploy only main's newest commit; HSTS; the command guard for Claude Code (`.claude/settings.json` deny rules and the PreToolUse hook). Always Use HTTPS on the zone is already on (turned on 2026-10-08).
  - from #21: the `ludion_ask` header line (lessons are data, not instructions); subject-name guards. The claim guards are replaced by v2's generated claims and grounded `detail`.
- **Order of work.** Built in the order that reaches "Done when" fastest; `docs/progress.md` tracks it:
  1. Lesson format v1 (schema, generated claim, grounded `detail`, `signal`, pinned and differential tests), with `tools/verify` and `packages/core`.
  2. `ludion` CLI: `teach` into the personal ledger, `sync` into `.ludion/lessons.md`. This reaches Done 1 (single player) with no server change.
  3. Index shards per subject, built with the site; `teach --public` through `gh`; `ludion_ask` and `ludion_teach` updated. With npm publishing this reaches Done 2 (plumbing).
  4. FreshBench per model: fix the 2026-10-08 answer keys, label loud/silent, record which models miss each change, feed `models` into the shards.
  5. 30 seed lessons (silent changes in vitest, then wrangler and agents), differential tests first.
  6. FreshBench under realistic conditions, with and without `ludion sync`: Done 3 (value).
  7. Then the Claude Code plugin, the site pages, and nightly reverify.

## Carried over from v0

These describe the system as built through 2026-10-08 and stay true unless a v2 decision above changes them.

### Infrastructure

- One Cloudflare Worker, `ludion` (Hono), serving the prerendered Astro site from `apps/site/dist` as static assets, `/index.json`, and `/mcp`. Custom domain `ludion.ai` in `wrangler.jsonc`. No content database (no KV, D1, or R2): GitHub is the database, and the index is rebuilt with every deploy.
- **Deploys** happen only in `.github/workflows/deploy.yml`: on every push to `main` and by `workflow_dispatch`, environment `production` (main only), `contents: read`, one deploy at a time and never cancelled. Steps: typecheck, build, test, `npx wrangler deploy` with the repo's wrangler, then `tools/check-production.ts` (the new `built_at` within 2 minutes, `/mcp` initialize 200, `ludion_ask` returns "Taught by @"). Actions pinned to commit SHAs. The build gets the job's own read-only token for teacher login lookups. No preview deployments. Workers Builds is disconnected. To deploy again, start a new run from main (`gh workflow run deploy.yml --ref main`), never a rerun of an old run.
- `CLOUDFLARE_API_TOKEN` is currently a repository secret; the owner was advised to move it to the `production` environment. `CLOUDFLARE_ACCOUNT_ID` is an environment secret.
- **Branch protection on main**: PRs required, 0 approvals (one maintainer), required checks `verify` and `test` pinned to the GitHub Actions app, administrators included, no force pushes or deletion, squash merge only, auto-merge on, head branches deleted after merge.

### Lessons and the index

- One file per lesson: `lessons/<subject>/<id>.json`, id a ULID, subject `^[a-z0-9][a-z0-9.-]{0,63}$` (also the directory). Canonical JSON (`formatLesson`: keys in schema order, absent optional fields omitted, 2-space indent, trailing newline); CI rejects anything else.
- The active set: all lessons on main minus every id named in another lesson's `replaces`.
- `index.json` is built from the active set at site build: each lesson with `teacher` (the current login for `teacher_id`, looked up at build time by numeric id, falling back to the stored login), `verified_by` (`proof` if any Lean run, else `test` if any run, else `source`), `verified_at` and `pr` (from the git commit that added the file), and the lesson URL. Lessons newest first; warn above 5 MB.
- The Ajv validator is compiled ahead of time into `packages/core/src/generated/validate-lesson.js` (`npm run gen:validator`), because Workers forbid runtime code generation; a test fails if it is stale.

### CI (`verify.yml`, `test.yml`)

- `verify` runs on every PR, never `pull_request_target`, with `contents: read` and no secrets. A PR that touches no lesson passes at once. A lesson PR may change only `lessons/<subject>/<id>.json` files: added ones are validated against the **base branch's** schema and canonical form, their path checked, `replaces` checked against the base branch's active set, `run` evidence run in Docker, `source` evidence checked; deleted ones are retractions (label `retract`); modified ones fail ("Lessons are immutable").
- Author rule: a person's PR must have `author_id` equal to the PR author's numeric id. (A bot rule for the GitHub App existed for #13 and goes away with it.)
- Runners: `python` (`python:3.14-slim`), `bash` (same image), `node` (`node:24-slim`), `lean` (none yet: label `needs-lean`). Docker flags: `--network none --memory 512m --cpus 1 --pids-limit 128 --read-only --tmpfs /tmp`, 30-second timeout, images pulled before any run. Code on stdin; exit 0 means the claim holds; a `skip:` line means the runner can't test it.
- Source checks: `https:` only, default port, no IP-address hosts, no internal names; redirects followed by hand (at most 3); only HTML or plain text, at most 2 MB, 5 seconds; normalized text must contain the normalized quote. The CI fetch resolves the name itself, refuses any non-public address, and connects to exactly the checked address (no DNS rebinding).
- Labels (`skipped`, `needs-lean`, `retract`) are set by a separate `label` job that never runs lesson code.
- `test`: typecheck, build, Vitest (Node and workerd projects), Playwright with axe on every page in both themes.

### Search and MCP

- `/mcp` is MCP over Streamable HTTP, stateless (`agents/mcp/server` with the v2 MCP SDK). `ludion_ask(question ≤ 8,000 chars, subject?, k?)` searches the index loaded through `ASSETS`. Output: one block per lesson (claim; "Taught by @login. Verified by … on …. Applies to …."; URL), or an exact no-match text.
- Search returns a lesson only on a strong match: an identifier, version number, flag, pseudo-class, a word in capitals or camelCase, or any word not on the common-word list; two common words when the question has no strong word; a word the lesson writes as code plus one more word. Subject names never count. Long pastes are searched by their last error line and strong words. `packages/core/test/search-eval.test.ts` holds the eval (off-topic and subject-only questions find nothing; error messages and mixed Japanese find their lesson; on-topic at least 90% in the top 3).

### Site

- Astro, static. Design B: black and white, no hue; Schibsted Grotesk and JetBrains Mono (ligatures off); the verified seal names its evidence (`exit 0`, `proved`, `quote found`); the home page's water surface (WebGL2, reduced motion = one still frame). Tokens in `apps/site/src/styles/tokens.css`. All UI strings in `apps/site/src/strings/en.ts`.
- WCAG 2.2 AA in both themes, axe clean on every page, home JavaScript at most 60 KB gzipped, CSP `default-src 'self'` (headers in `apps/site/public/_headers`), canonical links with the trailing slash.

### Bench

- `tools/bench` runs questions through Claude Code headless in a new empty folder with a run-only configuration, saves raw logs, stops before a spending cap, and grades with a separate tool-less judge. Results of 2026-10-08: `docs/bench/2026-10-08/` (FreshBench v0) and `docs/experiments/e1/` (ask rate).
