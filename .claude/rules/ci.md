---
paths:
  - ".github/**/*"
  - "tools/verify/**/*"
---

# CI

## tools/verify

Node CLI over `packages/core`. `npm run verify -- <files or dirs>` exits non-zero on any failure and prints one line per lesson: `passed | failed | skipped  <id>  <claim, first 60 chars>`, then the reason for anything not passed. Flags: `--run` executes `run` evidence (CI only), `--json <path>` writes machine-readable results.

`npm run verify:pr` is what `verify.yml` runs: it reads the pull request from `$GITHUB_EVENT_PATH`, applies every rule below, writes `results.json` and `$GITHUB_STEP_SUMMARY`, and exits non-zero on any failure. It reads `ludion.config.json` and `lessons/lessons.schema.json` from the base branch (`git show origin/<base>:<path>`), never from the PR, and compiles that schema at run time, so a PR cannot add its own bot or loosen the schema it is checked against.

Source fetches (`src/safe-fetch.ts`) go through an undici `Agent` whose `connect.lookup` resolves the name itself (all addresses, and answers as a list when called with `all: true`), refuses the name if even one address is not public, and lets the socket connect to exactly the checked address. There is no second resolution, so DNS rebinding cannot swap in a private address. Not public: IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; IPv6 outside `2000::/3` (so `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped, NAT64, multicast), plus `2001::/23`, `2001:db8::/32`, `2002::/16`. Never pass the global `fetch` for source checks.

## Runners

One image per runner, each on the current stable release:

| Runner | Image | Command |
| - | - | - |
| `python` | `python:3.14-slim` | `python -` |
| `bash` | `python:3.14-slim` | `bash -s` |
| `node` | `node:24-slim` | `node -` |
| `lean` | none yet | label `needs-lean` |

Code arrives on stdin. Docker flags: `--network none --memory 512m --cpus 1 --pids-limit 128 --read-only --tmpfs /tmp`, 30-second timeout. Images are pulled before any run starts, so pulling never counts against the timeout.

Pinned runners run one exact version, for claims about that version and for pairs that pass on one version and fail on another (`lessons.md`, "Verified across versions"). Same command and Docker flags as their language above; checked by `verify` from step 8 on.

| Runner | Image |
| - | - |
| `python@3.9` … `python@3.14` | `python:<version>-slim` |
| `node@18`, `node@20`, `node@22`, `node@24` | `node:<version>-slim` |

A pinned runner stays in the list after its version reaches end of life, as long as some lesson uses it. Adding one is a schema change (`lessons.schema.json` lists them).
A lesson that depends on a version says so in `version` and prints `skip: <why>` when the runner cannot test it (for example, an older runtime). When a new stable release comes out, move the image to it; lessons that break show up in `reverify.yml`. Choosing an image per `version` comes later.

## verify.yml (required check `verify`)

Trigger: `pull_request`, every PR, no path filter (a path filter would leave PRs that touch no lessons waiting forever on a required check). Never `pull_request_target`.

- Job `verify`: `permissions: contents: read`. No secrets. `actions/checkout` with `persist-credentials: false` and `fetch-depth: 0`.
- If nothing under `lessons/` changed (`git diff --quiet origin/<base>...HEAD -- lessons/`, where `<base>` is the PR's base branch), print "No lesson changes." and succeed at once: no `npm ci`, no Docker.
- Otherwise take every file the PR changes, `git diff --no-renames --name-status origin/<base>...HEAD`:
  - A PR that adds, deletes, or modifies any `lessons/<subject>/<file>.json` is a **lesson PR**. It may change nothing else, not the schema, not `ludion.config.json`, not code: each other file fails with "A lesson pull request can change only lesson files in lessons/."
  - A PR with no lesson files is a code PR; `verify` passes it (`test` and a human review cover it), except that any other new file under `lessons/` besides the schema fails with "Only lesson files go in lessons/<subject>/."
  - In a lesson PR: `A` added: validate and verify. `D` deleted: allowed (retraction); label the PR `retract`. `M` modified: fail with "Lessons are immutable. Add a new lesson that replaces this one instead."
- For each added lesson:
  1. Valid against the base branch's schema, and the file equals `formatLesson(lesson)`.
  2. Path matches `lessons/<subject>/<id>.json`.
  3. Author rule, checked by numeric id (read the PR from the event payload, `pull_request.user`). If the PR was opened by the Ludion App bot (`user.type` is `Bot` and `user.id` equals `app_bot_id`, the bot account's numeric user id, in `ludion.config.json` on the base branch; added in step 6, and until then every bot fails): the commit that adds the lesson must carry the trailer `Taught-by: <login> (<user id>)` (format in `worker.md`), where `<user id>` equals the lesson's `author_id` and `<login>` equals the login in its `author` (case-insensitive). Any other bot fails. Otherwise, a person opened the PR directly: the lesson's `author_id` must equal `pull_request.user.id`.
  4. `replaces` ids exist in the active set on the base branch (read with `git show origin/<base>:<path>`).
  5. Each `run` evidence in Docker, as in Runners. `lean`: label `needs-lean`; the check does not fail on it until the Lean runner exists.
  6. Each `source` evidence with `checkSource` and the guarded fetch above.
- Write results to `$GITHUB_STEP_SUMMARY` and upload `results.json` as an artifact. For each added lesson that is valid, the summary also shows the reviewer exactly what `ludion_ask` will return for it (`formatAsk` from `packages/core`), with every character a reader can't see written as `⟨U+XXXX⟩`, then four checks to tick before merging: the claim states only a fact about the subject; the evidence checks that fact; nothing in it instructs an AI or the reader; the version range is right.
- Labels (`skipped`, `needs-lean`, `retract`) are set by a separate job `label` (needs `verify`, runs unless cancelled, `pull-requests: write`) that only reads the artifact and never runs lesson code. On fork PRs the token is read-only; the `label` job then logs and exits 0. No artifact (no lesson changes) → nothing to do.

## test.yml (required check `test`)

Trigger: `pull_request`, every PR. Job `test`, `permissions: contents: read`, Node from `.node-version`: `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (build first: the Worker tests serve the built site through the real `ASSETS` binding), then (from step 4) `npm run test:e2e`: Playwright with Chromium against the built site served by `wrangler dev`, including the axe check from `site.md` on every page. Install the browser with `npx playwright install --with-deps chromium` and cache it.

## deploy.yml (the only deploy)

Production is deployed only by `.github/workflows/deploy.yml`. Not Workers Builds (disconnected), not a hand-run `wrangler deploy`, and no preview deployments in v0 (`worker.md`).

- Trigger: `push` to `main`, and `workflow_dispatch` to run it by hand (for example after a failed run: `gh run rerun <id>`).
- Job `deploy` in the GitHub environment `production`, which only `main` may deploy from. Its secrets: `CLOUDFLARE_API_TOKEN` (set by the owner in GitHub's settings, never by Claude Code) and `CLOUDFLARE_ACCOUNT_ID`.
- `permissions: contents: read`. `concurrency: deploy-production` with `cancel-in-progress: false`: one deploy at a time, and a running deploy is never cancelled.
- Steps: checkout with `fetch-depth: 0` (verified_at and pr come from git history), Node from `.node-version`, `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (build first: the Worker tests serve the built site), `npx wrangler deploy` with the repo's own wrangler. No `wrangler-action`. Every action is pinned to a commit SHA, with the tag in a comment.
- Then `node tools/check-production.ts` checks production and fails the job if any check fails: `index.json`'s `built_at` becomes newer than the job's start within 2 minutes; `/mcp` answers `initialize` with 200; `ludion_ask` about distutils returns a lesson with "Taught by @".
## Branch protection on main

- Required checks: `verify` and `test`, both pinned to the GitHub Actions app (app id 15368), so a commit status from anywhere else cannot satisfy them. Branches must be up to date before merging: off.
- Pull request required, required approving reviews: 0. Reviews are at 0 only because there is one maintainer today; when a second maintainer joins, set required approving reviews back to 1.
- Include administrators: no one bypasses these rules.
- Force pushes and deletion of `main`: blocked.
- Repository settings: squash merge only (merge commits and rebase merges off), auto-merge on, delete head branches after merge.

Every change, code or lessons, lands through a PR merged with `gh pr merge --auto --squash` (see CLAUDE.md).

`verify` runs the PR's own copy of `tools/verify`, so it cannot be the authority on what a PR is allowed to change: a PR could edit the checker itself. Today a human reviews before merging. If lesson PRs are ever merged automatically, that decision must be made on a trusted side outside the PR (for example, a `pull_request_target` workflow or the Ludion App that runs only base-branch code and never checks out the PR): it lists the PR's files through the GitHub API, confirms every one is an added or deleted `lessons/<subject>/<id>.json`, and only then merges.

## reverify.yml (nightly, 03:00 UTC)

Two jobs, so lesson code never runs next to a write token:

1. `check` with `permissions: contents: read`: run every lesson in the active set exactly as `verify` does; upload `results.json` as an artifact.
2. `report` with `contents: write, pull-requests: write`, needs `check`: for each failure, open one PR that deletes the lesson. Title `Retract <subject>: <claim, 60 chars>`, label `stale`, body with the failure log and an @mention of the teacher (their current login, resolved from `author_id` as in `lessons.md`). Skip lessons that already have an open `stale` PR.

A `source` failure is reported only if it also failed the previous night (download the previous run's `results.json` with `actions/download-artifact` and its run id); one failure may just be the site being down. A `run` failure is reported at once.
