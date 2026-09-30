# RPT-1 fixtures: metadata events and the daily report's ground truth

`generate.mjs` writes everything here, deterministically (seeded). RPT-1 regenerates it into a
temp dir and requires the committed files to be byte-identical, so the truth cannot be edited by
hand. The truth comes from the generator's hand-labelled tables, never from `@ludion/report`.

- `events/gate-events.ndjson`: metadata events in the exact shape gate-core's `metadataEvent`
  emits (spec §11.7), one per line, for two sites, around 2026-09-29 and around the New York DST
  change on 2026-11-01. It also holds lines that are not automation events (garbage, a truncated
  line, a string timestamp, a `HUMAN` and an `UNKNOWN` class, `null`, an array) and one blank line.
- `truth/<case>.truth.json`: one site, one day, one time zone, and what the report must say.
- `truth/canaries.json`: strings no rendering may contain.

## Cases

| case | date | zone | window (UTC) | why |
|---|---|---|---|---|
| a-jst | 2026-09-29 | Asia/Tokyo | 09-28 15:00 → 09-29 15:00 | the founder's zone; boundary events on and one second off both edges |
| b-utc | 2026-09-29 | UTC | 09-29 00:00 → 09-30 00:00 | default zone |
| c-nyc-dst | 2026-11-01 | America/New_York | 11-01 04:00 → 11-02 05:00 | a 25-hour day; a fixed offset loses the last hour |
| d-no-previous | 2026-10-30 | UTC | 10-30 00:00 → 10-31 00:00 | no events the day before: no day-over-day numbers |

## Definitions (the generator holds its own copy)

- **Automation event**: an object with a string `site`, a numeric `ts` (seconds), a `class` in
  VERIFIED, UNVERIFIED, SPOOFED, REVOKED, DECLARED, SUSPECTED, a `decision` in allow, friction,
  deny, and an integer `pressure` 0–3. Anything else is *skipped* and counted as such. Only
  `site, ts, method, route, class, decision, pressure, diver` are ever read.
- **Day**: local midnight to local midnight in the report's zone, `[start, end)`.
- **Route kind**: gate-core `routeKind` (the deepest kind word wins; then `/api/…`; static files;
  else browse). Routes carry no query, so a search is recognised by its path only.
- **Critical**: kind checkout, login, signup or account, or a write method (POST, PUT, PATCH,
  DELETE) on any route. **Unverified automation on critical routes** is every non-VERIFIED
  critical touch; *allowed / friction / denied* is the Gate's recorded decision for it.
- **Verified actions** (the North Star): events whose class is VERIFIED.
- **Verified agents**: distinct names among VERIFIED events. A name is the Diver id
  (`dvr-…`), or the host of an https/http identifier URL. Anything else — an IP-literal host, a
  non-URL — is `(unnamed)`: counted in the top list, never as a distinct agent, never shown.
  SPOOFED events may carry someone else's identifier; they never count as that agent.
- **Top lists**: agents top 5 by actions, critical routes top 8 by unverified touches; ties by
  name, ascending code-unit order.
- **Displayed route**: the event's route, path only, every segment that is not a template
  placeholder passed through `publicTemplateSegment` (route words stay, everything else is a
  placeholder). A raw `/checkout/4829-1733-canary?coupon=…` is shown as `/checkout/:token`.
- **Pressure 1 estimate**: among events recorded at Pressure 0, what gate-core `decide` does at
  Pressure 1: non-VERIFIED automation meets the site's existing friction, VERIFIED is exempt.
- **Previous day**: the same counts for the day before, in the same zone; `null` when that day has
  no events for the site (a report cannot tell "zero" from "not collected").
