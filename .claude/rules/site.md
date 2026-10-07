---
paths:
  - "apps/site/**/*"
---

# The site

Astro with `output: "static"`. Every page is prerendered from `lessons/` at build time. Interactive parts are small React islands that call the Worker's `/api/*`. No server rendering. All UI strings live in `apps/site/src/strings/en.ts`.

## Pages

Built in step 3: `/lessons/<id>/`, `/lessons` (the static list), `/teachers/<login>/`, 404, `index.json`, and a placeholder home (headline, sub, recently verified). The nav shows only links whose pages exist; the rest (search on `/lessons`, Teach, Start, Why, the full home) arrive with steps 6 and 7. Step 4 gives every page its design.

### `/` Home

- Header: wordmark "Ludion" (text), nav Lessons, Teach, Start, Why. Right: "Sign in" or the teacher's avatar linking to `/@<lowercase login>` (from `/api/session`).
- Hero, left-aligned: headline, sub, primary button **Add Ludion to your assistant** (→ `/start`), secondary link **See the lessons** (→ `/lessons`).
- Ask box (island): label "Ask Ludion", placeholder "What changed in distutils in Python 3.12?". Loads `/index.json` on first focus, searches client-side with `packages/core`, shows compact lesson cards. On no match: "No lesson yet for this. Know the answer and can show it? **Teach it.**" (→ `/teach`).
- Live feed (island), h2 "Being taught right now": up to 12 rows, each a status chip, the claim on one line, `@teacher`, relative time. Skeleton of 3 rows, then `/api/feed`; poll every 30 s while the tab is visible. When a row changes from checking to verified, that row flips (see Motion). If the feed is empty: "Nothing is being checked right now. Recently verified:" followed by the newest 5 lessons from build-time data.
- Footer: "<N> lessons from <M> teachers." (build time), license line, GitHub link.

### `/lessons`

h1 "Lessons". Search input and subject chips (the 12 most common subjects, plus "All"). Compact cards, newest first. The static HTML lists the newest 100; with JavaScript the full index is searchable, and `?q=` and `?subject=` stay in the URL. No match: "No lesson matches. Teach the first one."

### `/lessons/<id>/`

Built for every lesson on main, including replaced ones (history stays visible; only the active set is searchable).

- h1: the claim.
- Meta: chip **Verified by test** (or proof, or source), "on Oct 8, 2026", "Applies to python >=3.12".
- The teacher's signature right under the claim: "— @login" (avatar `https://avatars.githubusercontent.com/u/<teacher_id>?s=40`, by id so it survives renames, linking to `/@<lowercase login>`), with how and when it was verified.
- Evidence: each `run` as "Test (python)" with a code block and a copy button; each `source` as a block quote of the quote and a link labelled with the host.
- If this lesson replaces others: "Corrects" with links. If another lesson replaces it: banner at the top, "This lesson was corrected by <link>."
- Links: "View the file on GitHub", "Pull request #42".

### `/teachers/<lowercase login>/` (served at `/@<login>`)

One page per `teacher_id`, at the current login lowercased (see `lessons.md`). Every link to a teacher uses `/@<lowercase login>`. Avatar 64 px (by `teacher_id`), h1 `@login` in its current case, "<N> lessons in <S> subjects", subject chips, the teacher's active lessons as compact cards, link to the GitHub profile.

### `/teach` (island)

States:

1. Signed out, no draft: h1 "Teach Ludion", "Your GitHub name is shown on every lesson you teach.", button **Sign in with GitHub** (→ `/auth/login?next=/teach`).
2. Signed out, with a draft in `#d=`: the draft as a preview card, the line "Sources are checked after you sign in.", and **Sign in with GitHub to sign this lesson**. No check runs while signed out. Save the draft to `sessionStorage` key `ludion:draft` before redirecting, restore it after.
3. Signed in: the form, prefilled if a draft exists, with a live preview card beside it (below it on narrow screens). When a draft from `#d=` (or restored from `sessionStorage`) opens while signed in, call `/api/check` once automatically and show the results, one line per source ("Quote found on <host>" or the `source_not_found` copy) and "CI will run this test" per test, above the **Teach** button. **Teach** is disabled while a check is running and after a failed check, until the draft is edited and checked again.
4. Submitted: "Pull request #42 is open in your name." and a status chip polling `/api/pr/42` every 10 s. Verified: "Verified. Live for everyone in a few minutes." and the lesson link once it answers 200. Failed: "CI could not verify this lesson." with a link to the PR checks.

Form:

- Subject: hint "lowercase, like python or wrangler".
- Version (optional): hint "for example >=3.12".
- Claim: textarea with a 0/400 counter; hint "One sentence. Write it the way you would tell a colleague."
- Evidence, up to 3, each a **Test** or a **Source**. Test: runner (Python, Bash, Node, Lean) and code in a monospace textarea; hint "Exits 0 only if the claim is true." Source: URL and quote; hint "Paste an exact sentence from the page."
- Buttons: **Check** (calls `/api/check`, shows results inline) and **Teach** (calls `/api/teach`).

Error copy, by API `error` code:

| Code | Message |
| - | - |
| `signin_required` | "Sign in with GitHub to teach." |
| `account_too_new` | "GitHub accounts must be at least 30 days old to teach. This keeps spam out of Ludion." |
| `invalid_draft` | Field messages from `errors[]`, shown under each field. |
| `source_not_found` | "This source could not be confirmed. Link to a public https page and copy a sentence exactly as it appears there." (The API says why no further, on purpose.) |
| `rate_limited` | "You've checked too many lessons in the last minute. Wait a minute and try again." |
| `unknown_replaces` | "The lesson you're correcting isn't active anymore. Check its link." |
| `daily_limit` | "You've taught 20 lessons today. Come back tomorrow." |
| `github_error` | "GitHub didn't respond. Nothing was published. Try again in a minute." |

### `/start`

- h1 "Add Ludion to your assistant". "Ludion is a remote MCP server. Add this URL to any assistant that supports MCP:" then `https://ludion.ai/mcp` with a copy button.
- Tabs. Claude Code: `claude mcp add --transport http ludion https://ludion.ai/mcp`. Then Claude (web and desktop), Cursor, Codex, Other. For every tab except Claude Code, check the client's current documentation before writing the steps, and publish only steps you verified.
- "Try it": "Ask your assistant: What changed about distutils in Python 3.12? Use Ludion."
- "Teach it something": "Correct your assistant and ask it to teach Ludion. It gives you a link to sign."

### `/why`

One essay, 500 to 700 words, prose only, no subheadings. Title: "The internet lost its write path for knowledge." The argument, in order:

1. For 25 years people wrote the web and machines read it. Now people ask models, and fewer write.
2. Models learn once and freeze. The corrections people make every day vanish inside private chats, and what the next model learns arrives months later, with no names on it.
3. Wikipedia gave the encyclopedia an edit button. Ludion gives models one.
4. How it works: a lesson is one sentence with evidence; machines check it; the person signs; main is truth; every assistant can use it within minutes; the name stays.
5. What Ludion will not do: serve anything unverified, let an AI publish in your name, or own the knowledge (lessons are CC BY-SA).
6. End: "Teach it once."

Every number in the essay links to its source. If a number has no source you can link, leave it out.

### 404

"No page here. Search the lessons or teach one."

## Components

`LessonCard` (full, compact), `StatusChip` (checking, verified, failed, closed), `EvidenceRun`, `EvidenceSource`, `TeacherLink`, `AskBox`, `Feed`, `TeachForm`, `SignInButton`. Lessons are lists, not card grids.

## Design

The look is decided in step 4 by looking at real pages. The first round was quiet and safe and was not adopted. The second round aims higher:

- The goal is that the site looks great at first sight. Safe is not the goal. It holds up next to the best developer tools, without resembling any particular site.
- Gradients, light, depth, translucency, texture, and motion may be used on two conditions. They mean something: a gradient shows depth or an amount of light, never color for its own sake, and motion shows a change of state. And they never lower the readability or contrast of body text.
- Not used: the usual AI-startup look (purple-to-blue glowing gradients, gradient-filled text, glass cards that mean nothing, noise sprinkled over the whole screen), off-the-shelf shader presets, emoji, stock images, made-up numbers.
- Kept: WCAG 2.2 AA in both themes. Under `prefers-reduced-motion` nothing moves. Home JavaScript at most 60 KB gzipped.
- The content is the hero, and provenance is always visible: who taught it, when and how it was verified, and where to check.
- The verified state is the most eye-catching thing on a page; no decoration competes with it. A status is never shown by color alone (there is always a word). When a lesson turns verified, announce it with `aria-live="polite"` ("Verified: <claim, first 60 chars>").
- The teacher's name is a signature on the claim: right under it, a line "— @login", with how and when it was verified.
- Subject tags never share the status chip's shape.
- Home headline "Teach it once.", and under it "Everyone's AI learns it in minutes. Your name stays on it." No buttons until `/start` exists.
- The footer sits at the bottom of the screen even when the page is short.
- Type: the Latin faces are chosen in earnest (no default serif that reads as Times at large sizes) and must sit well next to a Japanese face later. Fonts are self-hosted (the CSP allows only `'self'`). The wordmark is drawn, not just typed.
- Lessons are lists, not card grids. Pages work down to 360 px wide.

Step 4, round 2, in order:

1. Read the frontend-design skill and check each proposal against its list of traits common to AI-made designs. (Round 1 matched "a dark background with one bright green accent".)
2. Build two proposals. A, "Ludion": a ludion is the little diver that rises and sinks in a bottle of water; a lesson rises to the surface when it is verified. A checking lesson sits a little deeper, darker and softer; a verified one surfaces, bright and sharp. Depth is a gradient, the surface is light. The home page replays the moment of teaching once with a real lesson, never presented as happening live. B: a different direction.
3. Check both against sample data that never enters `lessons/` and never reaches production (`apps/site/samples/`, built only with `LUDION_SAMPLES=1`): short and 400-character claims, test, proof, and source, a corrected lesson, a long login, several teachers.
4. Capture the home and lesson pages at 390 px and 1280 px, light and dark, plus a Playwright video of the motion. Critique and fix at least twice.
5. The owner picks one. Then this section is replaced with a few lines recording what was chosen and why, and the tokens live in `apps/site/src/styles/tokens.css`.

## Budgets

- Home JavaScript at most 60 KB gzipped. `index.json` loads only on ask-box focus or on `/lessons`.
- LCP at most 1.5 s on a mid-range phone over 4G; CLS at most 0.05.
- WCAG 2.2 AA. axe (`@axe-core/playwright`, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) finds no violations on any page, in light and dark; this runs in `test` on every PR from step 4 on. Lighthouse accessibility at least 95 on every page.
- Every page has a `<link rel="canonical">` to its URL with the trailing slash, because the URL without it only redirects there temporarily (307).

## Headers (`apps/site/public/_headers`)

```
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/index.json
  Cache-Control: public, max-age=60
  Access-Control-Allow-Origin: *
```

`index.json` is open to every origin on purpose: the lessons are a commons.
