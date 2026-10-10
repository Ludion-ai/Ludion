# Decisions

CLAUDE.md is the spec. This file holds the details it leaves to us: what was decided, and why. Newest decisions go at the top of their section. When a decision changes, edit it here in the same PR as the code, and say what it replaced.

## v2 decisions

### 2026-10-11: Switching to spec v2

- CLAUDE.md is the v2 spec, word for word. `.claude/rules/` is deleted. What those files said about the system as it runs today is kept below under "Carried over from v0"; what v2 changes is recorded here as the work happens.
- **PRs from before v2.** #13 (server-side teaching: GitHub App, OAuth, sessions, `/api/teach`, `/teach`) is closed unmerged: teaching moves to the teacher's machine. #23 (read path = `ludion_ask` alone) is closed: v2's read path is `ludion sync`. The useful parts of #19, #20, and #21 are folded into the v2 work and those PRs are closed when the work that carries them is open:
  - from #19: optional `kind`, runners pinned to versions, `expect: fail` + `error` (the basis of lesson format v1), and the FreshBench method (A/B questions, seeds kept out of the measurement, an LLM judge with spot checks, budgets).
  - from #20: deploy only main's newest commit; HSTS; the command guard for Claude Code (`.claude/settings.json` deny rules and the PreToolUse hook). The zone's Always Use HTTPS was turned on through the Cloudflare API on 2026-10-08 at the owner's request; it is a zone setting, so the repo can't show it (check with `curl -sI http://ludion.ai/`, which answers 301).
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

### Conventions

- TypeScript strict, Node 24 LTS (`.node-version`, used by CI and the deploy job), npm workspaces.
- Vitest 4 everywhere, pinned until `@cloudflare/vitest-plugin` supports a newer major, so Worker tests run inside workerd with the real `ASSETS` binding over the built site.
- Playwright for end-to-end checks and the axe check on every page.
- Code outside `tools/` and build scripts uses only web-standard APIs (fetch, Web Crypto, Streams); Node-only APIs are allowed in `tools/` and build scripts.
- npm scripts are written in Node so they run on Windows and Linux; no bash-only commands.
- Small functions; no abstraction before the third use.
- Errors say what happened and what to do next, in plain words.
- Names in user language: teach, ask, lesson, teacher, sign, verified, checking.
- Commit messages and PR titles in English, imperative. Every PR description says what changed and how to undo it.

### Infrastructure

- One Cloudflare Worker, `ludion` (Hono), serving the prerendered Astro site from `apps/site/dist` as static assets, `/index.json`, and `/mcp`. Custom domain `ludion.ai` in `wrangler.jsonc`. `run_worker_first` covers `/mcp`, `/mcp/*`, and `/@*`; `/@<login>` serves `/teachers/<lowercase login>/` from the assets, or the 404 page.
- No content database (no KV, D1, or R2): GitHub is the database, and the index is rebuilt with every deploy.
- **Deploys** happen only in `.github/workflows/deploy.yml`:
  - Triggers: every push to `main`, and `workflow_dispatch`.
  - Environment `production` (main only), `contents: read`, one deploy at a time, and a running deploy is never cancelled.
  - Steps: checkout with `fetch-depth: 0`, typecheck, build, test, `npx wrangler deploy` with the repo's own wrangler (no wrangler-action), then `tools/check-production.ts`. The check needs the new `built_at` within 2 minutes, `/mcp` initialize answering 200, and `ludion_ask` about distutils returning "Taught by @"; any failure fails the job.
  - Actions are pinned to commit SHAs.
  - The build gets the job's own read-only token as `GITHUB_READ_TOKEN`, for teacher login lookups; it is never shipped in `dist/` or logged.
- **No preview deployments**: a Worker's secrets are shared by every version of it, so a preview would run with production's secrets. `wrangler.jsonc` has no `env` blocks. Workers Builds is disconnected.
- To deploy again, start a new run from main (`gh workflow run deploy.yml --ref main`). A rerun of an old run would deploy that run's old commit. Nothing stops that yet: the newest-commit guard from #20 is not on main, and a v2 PR brings it in.
- `CLOUDFLARE_API_TOKEN` is currently a repository secret; the owner was advised to move it to the `production` environment. `CLOUDFLARE_ACCOUNT_ID` is an environment secret.
- **Branch protection on main**:
  - PRs are required, with 0 approving reviews because there is one maintainer; set it back to 1 when a second maintainer joins.
  - Required checks `verify` and `test`, pinned to the GitHub Actions app (app id 15368) so a status from anywhere else can't satisfy them. "Up to date before merging" is off.
  - Administrators are included; force pushes and deletion are blocked.
  - Squash merge only, auto-merge on, head branches deleted after merge.

### Lessons and the index

- One file per lesson: `lessons/<subject>/<id>.json`, id a ULID, subject `^[a-z0-9][a-z0-9.-]{0,63}$` (also the directory). Canonical JSON (`formatLesson`: keys in schema order, absent optional fields omitted, 2-space indent, trailing newline); CI rejects anything else.
- The active set: all lessons on main minus every id named in another lesson's `replaces`.
- `index.json` (`{version: 1, built_at, lessons, teachers}`) is built from the active set at site build. Each lesson carries:
  - `teacher`: the current login for `teacher_id`, looked up by numeric id with `GET /user/{id}` once per id per build, falling back to the login stored in that teacher's newest lesson;
  - `verified_by`: `proof` if any Lean run, else `test` if any run, else `source`;
  - `verified_at` and `pr`: from the git commit that added the file, where `pr` is parsed from the squash message's `(#n)` and a shallow clone is unshallowed first;
  - the lesson's GitHub URL.
- `teachers` is keyed by `teacher_id` (as a string). Lessons are sorted newest first, and the build warns above 5 MB. `index.json` is open to every origin (`Access-Control-Allow-Origin: *`), on purpose: the lessons are a commons.
- The Ajv validator is compiled ahead of time into `packages/core/src/generated/validate-lesson.js` (`npm run gen:validator`), because Workers forbid runtime code generation; a test fails if it is stale.

### CI (`verify.yml`, `test.yml`, `reverify.yml`)

- `verify` runs on every PR. It never uses `pull_request_target`, and it has no path filter, because a required check that never runs would leave PRs waiting forever.
  - It runs with `contents: read`, no secrets, and checkout with `persist-credentials: false` and `fetch-depth: 0`.
  - A PR that touches no lesson passes at once.
  - A lesson PR may change only `lessons/<subject>/<id>.json` files:
    - added ones are validated against the **base branch's** schema (read with `git show origin/<base>:…` and compiled at run time, so a PR can't loosen what it is checked against) and canonical form; their path is checked, `replaces` is checked against the base branch's active set, `run` evidence runs in Docker, and `source` evidence is checked;
    - deleted ones are retractions (label `retract`);
    - modified ones fail ("Lessons are immutable").
- **Trust boundary**: `verify` runs the PR's own copy of `tools/verify`, so it cannot be the authority on what a PR may change (a PR could edit the checker). Today a human reviews before merging. If lesson PRs are ever merged automatically, that decision must be made on a trusted side that runs only base-branch code and lists the PR's files through the API.
- Author rule: a person's PR must have `author_id` equal to the PR author's numeric id. (The bot rule for the GitHub App in #13 goes away with #13.)
- **Runners**: `python` (`python:3.14-slim`), `bash` (same image), `node` (`node:24-slim`), `lean` (none yet: label `needs-lean`).
  - Docker flags: `--network none --memory 512m --cpus 1 --pids-limit 128 --read-only --tmpfs /tmp`, a 30-second timeout, and images pulled before any timed run.
  - Code arrives on stdin; exit 0 means the claim holds; a `skip:` line means the runner can't test it.
  - Images move to each new stable release, and lessons that break show up in reverify.
- **Source checks** (`checkSource` in `packages/core`, `src/safe-fetch.ts` in `tools/verify`):
  - The URL, judged as `new URL()` parses it, on the first request and on every redirect target:
    - `https:` only, default port, no user name or password;
    - no IP-address hosts;
    - refuse single-label names, `localhost`, and names ending in `.localhost`, `.local`, `.internal`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.onion`.
  - Redirects are followed by hand, at most 3.
  - Only `text/html`, `text/plain`, or `application/xhtml+xml`; at most 2 MB, within 5 seconds; `User-Agent: LudionBot/0.1 (+https://ludion.ai/bot)`.
  - The page and the quote are normalized the same way (tags, entities, NFKC, case, whitespace, quotes and dashes), and the page must contain the quote.
  - **Never pass the global `fetch` to source checks on a machine that can reach private networks.** The CI fetch resolves the name itself and refuses the name if any address is non-public, then connects to exactly that address (no DNS rebinding). Non-public:
    - IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`;
    - IPv6 outside `2000::/3`, plus `2001::/23`, `2001:db8::/32`, `2002::/16`.
  - This matters again in v2, where `ludion teach` checks sources on the teacher's machine.
- Labels (`skipped`, `needs-lean`, `retract`) are set by a separate `label` job (`pull-requests: write`) that only reads the results artifact and never runs lesson code; on fork PRs its token is read-only and it logs and exits 0.
- `test`: typecheck, build (first, because the Worker tests serve the built site), Vitest (Node and workerd projects), and Playwright with axe on every page in both themes.
- **`reverify.yml`** (designed, not built yet; v2 still asks for nightly reverify):
  - Two jobs, so lesson code never runs next to a write token: `check` (`contents: read`) runs every active lesson as `verify` does and uploads `results.json`; `report` (`contents: write, pull-requests: write`) opens one retraction PR per failure and skips lessons that already have an open one.
  - A `source` failure counts only if it also failed the previous night (the site may just be down); a `run` failure counts at once.

### Search and MCP

- `/mcp` is MCP over Streamable HTTP, stateless (`createMcpHandler` from `agents/mcp/server` with `McpServer` from the v2 MCP SDK), open to any origin and accepting no credentials. The index is loaded through `ASSETS`, kept in module scope by `built_at`, and revalidated at most every 60 seconds.
- Server name `ludion`. Server instructions, exactly: "Ludion holds lessons that people taught and machines verified by test, proof, or cited source. Use ludion_ask before answering questions about specific software behavior, versions, or recent changes, and cite the teacher. Use ludion_teach only when the user asks to teach or corrects you with evidence."
- `ludion_ask`:
  - Input: `question` (1 to 8,000 characters), `subject?`, and `k?` (1 to 10, default 5). The description of `question`, exactly: "The user's question or the exact error message, in English. Include the library or tool name and its version if you know them."
  - Tool description, exactly: "Search lessons that people taught Ludion and machines verified by test, proof, or cited source. Use before answering questions about specific software behavior, APIs, versions, tools, or anything that may have changed recently. Each result names its teacher; cite them."
  - Annotations `readOnlyHint: true`, `openWorldHint: false`.
  - Output: one block per lesson (`N. <claim>` / `   Taught by @<teacher>. Verified by <test|proof|source> on <YYYY-MM-DD>. Applies to <subject> <version>.` / `   <lesson URL>`), plus `structuredContent: {lessons: [{id, subject, version, claim, teacher, teacher_id, verified_by, verified_at, lesson_url}]}`.
  - No match, exactly: "No lesson yet for this. If you know the answer and can show evidence (a test or a source with a quote), teach it with ludion_teach."
  - `ludion_teach` is not on main (it was in #13); v2 brings back a version that validates a draft and returns the `npx ludion teach` command.
- **Search** returns a lesson only on a strong match:
  - a strong word: an identifier, version number, flag, pseudo-class, a word in capitals or camelCase, or any word not on the common-word list;
  - when the question has no strong word, two common words;
  - a word the lesson writes as code, plus one more word of the question.
- Subject names never count. Long pastes are searched by their last error line and strong words.
- `packages/core/test/search-eval.test.ts` holds the eval: off-topic and subject-only questions find nothing; error messages and mixed Japanese find their lesson; on-topic questions find it in the top 3 at least 90% of the time.

### Site

- Astro, static. All UI strings live in `apps/site/src/strings/en.ts`.
- Design B: black and white with no hue; Schibsted Grotesk and JetBrains Mono (ligatures off). The verified seal names its evidence (`exit 0`, `proved`, `quote found`). The home page has a water surface (WebGL2; reduced motion shows one still frame). Tokens live in `apps/site/src/styles/tokens.css`.
- Design changes are checked against the sample lessons in `apps/site/samples/`, built only with `LUDION_SAMPLES=1` into `dist-samples`. They are never deployed: the build refuses that flag in Cloudflare.
- Budgets:
  - WCAG 2.2 AA in both themes;
  - axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) finds nothing on any page;
  - Lighthouse accessibility at least 95;
  - home JavaScript at most 60 KB gzipped;
  - LCP at most 1.5 s on a mid-range phone over 4G, CLS at most 0.05.
- Headers (`apps/site/public/_headers`): CSP `default-src 'self'` (avatars from `avatars.githubusercontent.com`), `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`, and a locked-down `Permissions-Policy`. Canonical links use the trailing slash.

### Bench

- `tools/bench` runs questions through Claude Code headless in a new empty folder with a run-only configuration: `--setting-sources project` in an empty folder, `--strict-mcp-config`, and only the condition's tools. It saves raw logs and stops before a spending cap, and a separate tool-less judge grades the answers.
- Method used on 2026-10-08, proposed in #19 (never merged):
  - changes from changelogs with dates and URLs, each with a quote that passes `checkSource`;
  - an A question (seed) and a B question (measurement) per change, with answer keys; seeds come only from A, measurement only from B;
  - conditions none, web, and ludion;
  - an LLM judge, with at least 10% of grades read by hand;
  - limits on runs, turns, and dollars written before each run.
- Results:
  - `docs/bench/2026-10-08/` (FreshBench v0). One answer key there, WebdriverIO, is known to be wrong and will be fixed against primary sources.
  - `docs/experiments/e1/` (ask rate).
