# tracecheck.dev pilot

The Ludion Gate at Pressure 0 in front of [tracecheck.dev](https://tracecheck.dev), as a Worker on the zone's own route (`tracecheck.dev/*`). tracecheck's code is not touched. The Worker sits between Cloudflare and the site.

- **It only observes.** Every request goes on to the site exactly as it came (`fetch(request)`), and the site's response is returned as the very same object, with no header added. The Gate inspects the request after it has gone on (`ctx.waitUntil`). `passThroughOnException` is set first, so a fault in the Worker sends the request straight to the site. A config with any Pressure above 0, or with a `report.endpoint`, is refused, and then the Gate is off while the site keeps working.
- **It keeps automation, never people.** Requests the Gate classifies as automation (VERIFIED, UNVERIFIED, SPOOFED, REVOKED, DECLARED, SUSPECTED) become one row each in a D1 database in the same Cloudflare account. A row holds the Gate's metadata event (spec §11.7) without the IP hash. It also holds a few fields that say why the request got its class: the operator a User-Agent names, the automation signal, the reason a signature failed, the host of the agent's key directory, and the signature's lifetime and nonce flag. Each of these is a word from a fixed list, a host name or a number. No query value, body, cookie, address or free text is kept. UNKNOWN requests (people) are never written.
- **One report every morning.** A cron at 22:00 UTC (07:00 in Tokyo) builds yesterday's report with [`@ludion/report`](../../packages/report), unchanged. It saves the report in D1 in Japanese and English and, if `REPORT_WEBHOOK_URL` is set, posts it: to Discord as a message with the HTML attached, to Slack as text. Events older than `RETAIN_DAYS` (90) are deleted, and reports are kept.

## Files

| File | What |
|---|---|
| `wrangler.jsonc` | The route, the D1 binding (created by `wrangler deploy`), the cron, the site config |
| `src/worker.mjs` | `fetch` (pass through, observe after) and `scheduled` (the report) |
| `src/observe.mjs` | The row for one request |
| `src/store.mjs` | D1: schema on first use, insert, paged reads, reports, retention |
| `src/daily.mjs` | Yesterday's report, the pilot's extras, the webhook |
| `test/pilot.test.mjs` | Node, with D1 on `node:sqlite` (in `npm test`) |
| `test/workerd.test.mjs` | The deployable Worker in workerd in front of a stub site (PILOT-1) |
| `summary.mjs` | A span of days, for the launch |
| `live.mjs` | PILOT-2: the last 7 days of the deployed pilot |

## Deploy

A person deploys it, into the Cloudflare account that holds the tracecheck.dev zone: see [DEPLOY.md](DEPLOY.md) (Japanese).

## Read the data

```sh
npx wrangler d1 execute ludion-tracecheck --remote --command "SELECT class, count(*) AS n FROM events GROUP BY class"
npx wrangler d1 execute ludion-tracecheck --remote --command "SELECT date, subject FROM reports WHERE lang = 'ja' ORDER BY date DESC LIMIT 7"
```

Over a span of days (the week before a launch), with the daily report's counting:

```sh
npx wrangler d1 execute ludion-tracecheck --remote --json --command "SELECT * FROM events" > rows.json
node summary.mjs --from 2026-10-04 --to 2026-10-10 --rows rows.json
```

`live.mjs` (PILOT-2) and `summary.mjs` without `--rows` read D1 through the Cloudflare API instead, with a read-only token of the tracecheck.dev account (`TRACECHECK_D1_READ_TOKEN`, `TRACECHECK_ACCOUNT_ID`, `TRACECHECK_D1_ID`).
