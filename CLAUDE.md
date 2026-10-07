# Ludion

Ludion is a public, writable AI model. People teach it. Every lesson is checked by a machine (a test, a Lean proof) or by a cited source before it is served, and it keeps its teacher's name. Everyone's assistant can use it within minutes of merge.

Latin *ludus*: a game, and a school. Ludion is where models go to school. People are **teachers**; units are **lessons**. Use these words everywhere: code, UI, tool names, errors.

## Where things are

- Site and API: `https://ludion.ai`. MCP: `https://ludion.ai/mcp`.
- Lessons repo: `github.com/<ORG>/ludion` (this repo). `<ORG>` lives in `ludion.config.json`; read it from there, never hard-code it.
- Tests before launch: end-to-end tests teach real lessons under the subject `ludion-selftest` and retract them afterwards. A separate staging setup comes before launch (spec to come).
- Licenses: lessons CC BY-SA 4.0 (`LICENSE-LESSONS`), code Apache-2.0 (`LICENSE`).

## The spec lives in `.claude/rules/`

| File | Covers |
| - | - |
| `.claude/rules/lessons.md` | Lesson format, the active set, `index.json`, `packages/core` |
| `.claude/rules/ci.md` | `verify.yml`, `reverify.yml`, `tools/verify`, sandboxing |
| `.claude/rules/worker.md` | The Worker: routes, MCP tools, API contracts, auth, GitHub App, secrets |
| `.claude/rules/site.md` | Pages, components, states, copy, design tokens |

They load when you touch matching files. Read the relevant file before you plan a step, not only when you edit.

## The product is the moment of teaching

1. In any MCP client, the user corrects their assistant: "That's wrong. Python 3.12 removed distutils."
2. The assistant calls `ludion_teach`. Ludion checks the draft and returns a signing link.
3. The user opens the link, signs in with GitHub once, and presses **Teach**. The assistant drafts; only the person signs.
4. A pull request opens in the teacher's name. CI runs the evidence in an isolated container. A maintainer merges.
5. Minutes later, every `ludion_ask` returns the lesson: *Taught by @alice. Verified by test on 2026-10-08.*

The home page shows the same moment live: lessons flip from **checking** to **verified**.

## Acceptance tests (v0 is done when both pass)

1. **Assistant.** Laptop A: Claude Code with Ludion added. The user corrects the assistant, opens the signing link, presses Teach. CI passes; a maintainer merges. Laptop B, five minutes after merge: `ludion_ask` returns the lesson with "Taught by @A".
2. **Web.** A teacher signs in at `/teach`, teaches a lesson with a test, watches its card flip from checking to verified on the home page after merge, and finds it on `/@<login>`.

## Architecture: one truth, one Worker

```
 lessons/ on main  ──build──▶  apps/site/dist (static pages + index.json)
       ▲                                │ served as static assets
       │ PR (GitHub App)                ▼
 CI (isolated) ◀── maintainer merge   one Cloudflare Worker "ludion"
                                        ├─ /mcp        ludion_ask, ludion_teach (no login)
                                        ├─ /api/*      check, teach (signed in), feed, session
                                        ├─ /auth/*     GitHub sign-in
                                        └─ everything else → static assets
```

- **Truth** is `lessons/` on `main`. If a lesson is on main, it was verified and merged. Nothing unverified is ever served.
- Every push to `main` rebuilds and redeploys through Workers Builds. `index.json` is rebuilt with the site, so "live" means "deployed".
- No content database. GitHub is the database. No KV, D1, or R2 in v0.
- Lesson code (`run` evidence) executes only in CI containers. Never in the Worker.

## Rules that do not bend

- **main is truth.** Served, searched, exported: only the active set on main.
- **Lessons are immutable.** Correct with a new lesson that `replaces` the old one. Retract by deleting the file. Git is the history.
- **The person signs.** No lesson leaves Ludion without a signed-in human pressing Teach. Tools never publish on their own.
- **Attribution is identity.** The author is the GitHub account that signed. CI enforces it. Identity is recorded as the account's numeric GitHub user ID (`author_id`), not the login: logins can change, and a freed login can be claimed by someone else.

## Say no (v0)

- No anonymous teaching, and no teaching without the person's click.
- No model training, LoRA, or memory layers. v0 delivery is search over `index.json`.
- No LLM calls in the write path. The claim is stored exactly as the teacher wrote it.
- No reputation scores, tokens, payouts, comments, likes, follows, notifications.
- No Japanese UI yet. Every UI string lives in one dictionary file, so Japanese is a translation, not a refactor.
- No blog, pricing, careers, or roadmap pages. No analytics beyond Cloudflare Web Analytics.
- No npm package in v0. The MCP server is remote.

If a feature is not needed to pass the acceptance tests, do not build it.

## Repo layout

```
CLAUDE.md
.claude/rules/       the spec
LICENSE  LICENSE-LESSONS  ludion.config.json
lessons/             lessons.schema.json and lessons/<subject>/<id>.json
packages/core/       pure TypeScript: types, validation, ULID, active set, search, index builder, source check
apps/site/           Astro, output "static"; reads ../../lessons at build; emits dist/ and dist/index.json
apps/worker/         Hono + MCP handler; serves apps/site/dist as static assets
tools/verify/        Node CLI used by CI and the nightly job
wrangler.jsonc       Worker "ludion"; assets dir apps/site/dist; secrets listed in worker.md
.github/workflows/   verify.yml, reverify.yml
```

## Before you start (owner, by hand)

- Finish deleting the old Cloudflare Workers, KV, R2, D1, and the old Vercel project. Keep the `ludion.ai` zone, the npm account, and the GitHub orgs.
- Create `<ORG>/ludion` (public). Write the org into `ludion.config.json`. Set the example lesson's `author` to your GitHub login and `author_id` to your numeric user ID (`gh api user --jq .id`).
- Step 5 needs a GitHub App. Claude Code prepares the settings in `worker.md`; a human clicks Create and installs it.
- In Cloudflare: connect this repo to Workers Builds, and attach `ludion.ai` as the Worker's custom domain.

## Order of work

Each step ends green: tests pass, and the step's check is demonstrated.

1. `packages/core`, `tools/verify`, schema, example lesson. Check: `npm run verify -- lessons/` passes; Vitest passes.
2. `verify.yml` and branch protection. Check: a PR with a failing test is blocked; a passing one is mergeable.
3. `apps/site` static build and `apps/worker` serving it. Deploy to `ludion.ai`. Check: `/lessons/<id>` and `/index.json` are live.
4. `/mcp` with `ludion_ask`. Check: `claude mcp add --transport http ludion https://ludion.ai/mcp`, then ask about distutils and get the example lesson with its teacher.
5. GitHub App, `/auth/*`, `/api/check`, `/api/teach`, `/teach`, and `ludion_teach`. Check: both acceptance tests pass with subject `ludion-selftest`; retract those lessons afterwards.
6. Home page live feed, `/start`, `/why`. Check: Lighthouse accessibility ≥ 95 on every page.
7. Seed 200 lessons in the wedge library. Check: each passes CI.
8. `reverify.yml`. Check: a lesson whose source quote disappears gets a deletion PR.
9. FreshBench (spec to come).

## Conventions

- TypeScript strict, Node 24 LTS (same as Workers Builds), npm workspaces. Vitest for unit tests; Playwright for the acceptance tests.
- Code uses only web-standard APIs (fetch, Web Crypto, Streams). Node-specific APIs are allowed only in `tools/` and build scripts.
- npm scripts are written in Node so they run on both Windows and Linux. No bash-only commands.
- Small functions. No abstraction before the third use.
- Errors say what happened and what to do next, in plain words.
- Names in user language: teach, ask, lesson, teacher, sign, verified, checking.
- Commit messages and PR titles in English, imperative.
