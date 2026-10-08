---
paths:
  - "lessons/**/*"
  - "packages/core/**/*"
  - "tools/**/*"
---

# Lessons and the core package

## A lesson

One file: `lessons/<subject>/<id>.json`. Schema: `lessons/lessons.schema.json`. Example: `lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json`.

| Field | Required | Meaning |
| - | - | - |
| `id` | yes | ULID (Crockford base32, 26 chars). Also the file name. |
| `subject` | yes | `^[a-z0-9][a-z0-9.-]{0,63}$`. Also the directory name. |
| `version` | no | Where the claim holds, e.g. `>=3.12`. Semver range for packages, free text otherwise. |
| `claim` | yes | One sentence, 10 to 400 chars, exactly as the teacher wrote it. |
| `evidence` | yes | 1 to 3 items, each `{"run": {...}}` or `{"source": {...}}`. |
| `author` | yes | `github:<login>` of the account that signed, as it was at signing. For display. |
| `author_id` | yes | GitHub numeric user id of the account that signed (integer, 1 or more). The teacher's identity. |
| `replaces` | no | ULIDs of lessons this one corrects. |
| `created_at` | yes | UTC, `YYYY-MM-DDTHH:MM:SSZ`, set at signing. |

Identity is decided by the numeric id. Logins can be changed, and a freed login can be taken by someone else, so a login alone could move a lesson to another person. The login is for display only; whenever logins are compared, compare them case-insensitively.

Subject naming: the canonical lowercase name of the thing. npm `@scope/name` becomes `scope.name`. Languages and tools by their common name: `python`, `node`, `wrangler`.

### Evidence

- `run`: `{"runner": "python" | "bash" | "node" | "lean", "code": "<= 8000 chars"}`. The code exits 0 if and only if the claim holds. Deterministic and offline. It may print a line starting `skip:` and exit 0 when the runner cannot test the claim (for example, an older runtime); CI then labels the PR `skipped` and a human decides.
- `source`: `{"url": "https://...", "quote": "8 to 300 chars"}`. The quote must appear on the page after normalization (below).
- Label shown to users, derived not stored: any `run` with runner `lean` → `proof`; else any `run` → `test`; else `source`.

### Rules

- Immutable. A merged lesson file is never edited. Correct it with a new lesson whose `replaces` lists the old id. Retract it by deleting the file.
- Canonical JSON: keys in the order of the table above, omit absent optional fields, 2-space indent (`JSON.stringify(lesson, null, 2)`, nested objects expanded too), UTF-8, trailing newline. `packages/core` exposes `formatLesson(lesson): string`, and CI rejects files that differ from it.
- `replaces` may only name lessons in the current active set.

## The active set

All lessons on `main` minus every id that appears in some other lesson's `replaces`. Everything served or exported uses the active set only.

## index.json

Built from the active set at site build time. Written to `apps/site/dist/index.json`.

```json
{
  "version": 1,
  "built_at": "2026-10-08T09:00:00Z",
  "lessons": [
    {
      "id": "01K6ZQ4T9X0N8V2H7M3P5R1S6W",
      "subject": "python",
      "version": ">=3.12",
      "claim": "Python 3.12 removed the distutils module ...",
      "evidence": [{"run": {"runner": "python", "code": "..."}}, {"source": {"url": "...", "quote": "..."}}],
      "teacher": "alice",
      "teacher_id": 1234567,
      "replaces": [],
      "verified_by": "test",
      "verified_at": "2026-10-08T08:57:12Z",
      "pr": 42,
      "url": "https://github.com/<ORG>/ludion/blob/main/lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json"
    }
  ],
  "teachers": {"1234567": {"login": "alice", "lessons": 1, "subjects": ["python"]}}
}
```

- `teacher_id` is the lesson's `author_id`. `teachers` is keyed by that id (as a string).
- `teacher` is the current login for `teacher_id`, looked up at build time with `GET https://api.github.com/user/{account_id}`, once per distinct id per build. If the lookup fails (deleted account, rate limit, network), use the login from the `author` of that teacher's newest lesson and log a warning.
- Lookups use `GITHUB_READ_TOKEN` when it is set: the deploy job passes its own read-only token (`deploy.yml`), so lookups aren't held to the unauthenticated limit of 60 requests an hour. Local builds without it are unauthenticated. The token is never shipped in `dist/` or logged.
- Teacher pages live at the lowercase login: `/teachers/<lowercase login>/`, served at `/@<login>` in any case. If two ids end up with the same lowercase login (possible only when a lookup failed and someone else now holds that name), the id whose login came from the API gets the page; the other's lessons show the name without a link.
- `verified_at` and `pr` come from `git log` of the file: the commit that added it. Squash merge messages end with `(#<number>)`; parse it. If the build clone is shallow, run `git fetch --unshallow` first.
- Sort lessons by `verified_at`, newest first.
- Size check: warn in the build log above 5 MB; the index is loaded whole by the Worker and the ask box.

## packages/core

Pure TypeScript. No Node-only or Worker-only APIs, so the site build, the Worker, and the CLI share it.

- `types.ts`: `Lesson`, `Evidence`, `IndexEntry`, `Index`.
- `schema.ts`: Ajv validator compiled from `lessons/lessons.schema.json` ahead of time into `src/generated/validate-lesson.js` (`npm run gen:validator`), because Workers forbid runtime code generation. A unit test fails if the generated file is stale. Returns `{ok: true} | {ok: false, errors: {path, message}[]}` with messages a person can act on.
- `ulid.ts`: `newId(now = Date.now())`.
- `format.ts`: `formatLesson`.
- `active.ts`: `activeSet(lessons)`.
- `search.ts`: MiniSearch over `claim` (boost 2) and `subject` (boost 1). `search(index, query, {subject?, k=5})`. It returns a lesson only when the question's meaningful words match it; an empty result means ludion_ask answers with its no-match text.
  - Words: lowercase; version numbers such as `3.12` stay one word; flags (`-V`, `--discard-changes`) and pseudo-classes (`:has`) stay whole; words split where letters meet digits (`python3.12` → `python`, `3.12`) and where Latin meets Japanese or Chinese (`distutilsはPython` → `distutils`, `は`, `python`). Stopwords (the, a, is, how, do, I, use, what, …) are dropped from questions and lessons alike; a light stemmer strips plural -s, then -ing or -ed.
  - Prefix matching only for words of 4+ characters, fuzzy matching (0.2) only for 5+, neither for version numbers, flags, or pseudo-classes.
  - A result is decided by what matched, not by how much. Strong words: identifiers and rare words (anything not on the common-word list in `src/common-words.ts`: everyday English plus generic programming words like file, error, module, version), version numbers, flags, pseudo-classes, and words typed in capitals or camelCase (`RETURNING`, `moduleResolution`). If the question has a strong word, a lesson must match one; the word it matched in the lesson must not be a subject name or, unless typed as code, a common word (`inst` finding `instead` doesn't count). If the question has no strong word, a lesson must match at least two common words. Subject names (`python`, `git`, `cloudflare`, `workers`) never count, so "What is Python?" finds nothing. Results scoring under half of the best one are dropped.
  - `test/search-eval.test.ts` checks this over the sample and real lessons: off-topic questions and subject-only questions must all find nothing; pasted error messages (with traceback lines) and questions mixing Japanese and English must all find their lesson; two natural phrasings per lesson must find the right one in the top 3 at least 90% of the time. The test prints the numbers. Add questions when lessons are added; re-run it before changing the rules.- `teachers.ts`: `resolveLogins(ids, fetchFn, token?)` → `Map<id, login>` via `GET /user/{account_id}`; ids that fail are left out.
- `index-builder.ts`: `buildIndex(lessons, gitInfo, logins, {org, repo})` → `Index`. Falls back to the stored `author` login for ids missing from `logins`.
- `source-check.ts`: `checkSource(url, quote, fetchFn)` → `{found: true} | {found: false, reason}`. `reason` is for CI logs and the CLI; the Worker never forwards it (see `worker.md`).
  - URL rules, `sourceUrlProblem(url)`, judged on the URL as parsed by `new URL()` (which rewrites decimal, hex, and octal IPv4 hosts to dotted form), before the first request and again for every redirect target:
    - `https:` only, default port only (443), no user name or password.
    - No IP-address hosts at all, public or private: refuse a host in dotted IPv4 form or starting with `[`.
    - Drop one trailing dot, then refuse single-label names, `localhost`, and names equal to or ending in `.localhost`, `.local`, `.internal`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.onion`.
  - Redirects are followed by hand (`redirect: "manual"`), at most 3; the 4th is refused.
  - Read only `Content-Type` `text/html`, `text/plain`, or `application/xhtml+xml`; anything else, or none, is refused. At most 2 MB, 5 seconds for the whole check, `User-Agent: LudionBot/0.1 (+https://ludion.ai/bot)`.
  - Normalization for both page and quote: strip comments, `<script>`, `<style>`, and tags (inline tags without a space); decode HTML entities; NFKC; lowercase; collapse whitespace; straighten quotes and dashes.
  - Name rules cannot see where DNS points. The `fetchFn` must refuse non-public addresses: `tools/verify` passes a fetch that checks and pins the resolved address (`ci.md`); the Worker's outbound `fetch` cannot reach private networks.
- `label.ts`: `verifiedBy(lesson)`.

Unit tests cover every function, including: a quote split across tags still matches; a replaced lesson leaves the active set; `formatLesson` round-trips the example byte for byte; a teacher who renamed their account shows the new login; a failed lookup falls back to the stored login.
