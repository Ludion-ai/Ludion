# @ludion/report

The daily report (spec §11.8): what automation did on your site yesterday, and how much of it
touched checkout, login and account routes without anyone being able to say whose agent it was.

It reads the Gate's metadata events (spec §11.7) and nothing else, and it writes. It does not send
mail, and it makes no network calls.

```bash
# the Gate's sink writes one JSON event per line; point the report at that file
npx ludion report --events gate-events.ndjson --tz Asia/Tokyo --lang ja --format html > report.html
npx ludion report --events gate-events.ndjson --date 2026-09-29 --tz Asia/Tokyo --lang ja            # plain text
npx ludion report --events gate-events.ndjson --date 2026-09-29 --format subject                      # a subject line
npx ludion report --events gate-events.ndjson --date 2026-09-29 --format json                         # the numbers
```

- `--date` defaults to yesterday in `--tz` (default `UTC`). `--site` is needed when the file holds
  several sites. `--lang` is `ja` or `en`, `--format` is `text`, `html`, `json` or `subject`.
- The HTML is email-safe: tables and inline styles only, with no images, scripts, fonts, style
  sheets or tracking.

What it shows:
- unverified automation on critical routes: let through, met friction, refused
- verified actions (the North Star) and verified agents
- automation by class and by route kind
- the top verified agents
- the busiest critical routes, as templates
- what Pressure 1 would change
- the change from the previous day

Routes are shown only as strict templates, and agents only by Diver id or host. Receipt ids, IP
hashes, countries and anything else an event may carry never appear. RPT-1 checks all of this,
along with every number in every rendering (`packages/report/test/rpt1.test.mjs`).
