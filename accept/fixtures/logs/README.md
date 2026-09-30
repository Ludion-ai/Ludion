# Scan corpus (SCAN-1, SCAN-2, SCAN-3)

`corpus/` holds one access log per format. `truth/` holds its ground truth. `generate.mjs` writes both (it is seeded and deterministic). SCAN-1 checks that the committed files are byte for byte what it writes, so nobody hand-edits a truth file to make a test pass. To change the corpus, change `generate.mjs` and rerun it.

Ground truth is labelled by hand in the generator's tables: each User-Agent carries its class and operator/signal, and each route carries its kind. The scan never computes it. Each vendor file also includes that vendor's documented example lines verbatim, labelled by hand.

Addresses come from documentation and benchmark ranges (RFC 5737, RFC 2544 `198.18.0.0/15`, RFC 3849 `2001:db8::/32`), plus the private addresses that appear in the vendors' own examples.

## Formats

| file | vendor | detected as | source of the layout | awkward on purpose |
|---|---|---|---|---|
| `nginx-access.log` | nginx | `combined` | stock `nginx.conf` `main` = combined + `"$http_x_forwarded_for"` | `\x22` / `\xHH` escapes (UTF-8 byte runs), TLS garbage request, empty request, 499, IPv6, absolute-form target, `$remote_user`, truncated last line |
| `apache-combined.log` | Apache httpd | `combined` | httpd docs `LogFormat … combined` (the docs example line included) | CRLF, `\"` and `\\` escapes, `%h` hostnames, a non-log line, truncated last line |
| `apache-common.log` | Apache httpd | `common` | httpd docs `common` | no User-Agent field at all (every request UNKNOWN; reported as `no_user_agent_field`) |
| `caddy-access.log` | Caddy | `caddy` | Caddy docs structured access log (docs example included, its trailing comma removed) | other loggers (`tls.obtain`, no logger) are not requests, request headers incl. `Cookie`, Web Bot Auth signature headers, truncated last line |
| `2026…_4c1f2e3d.log.gz` | Cloudflare Logpush `http_requests` | `cloudflare` | Cloudflare field reference | gzip, `EdgeStartTimestamp` in unixnano and one RFC 3339 job, `RequestHeaders` custom field carrying signatures, IPv6, truncated |
| `vercel-drain.ndjson` | Vercel log drain | `vercel` | Vercel drains reference (both docs examples included) | build logs, two entries per function request (counted once, by `requestId`), a JSON-array delivery on one line, firewall denials, `userAgent` as an array, truncated |
| `…_172.160.001.192_20sg8hgm.log.gz` | AWS ALB | `alb` | ELB docs field table (all 7 docs examples included) | gzip, the account ID and the node IP in the file name (must never be printed), `"- - - "` unparseable request, IPv6 client, WebSockets, truncated |
| `E2EXAMPLE….gz` | CloudFront standard (legacy) | `cloudfront` | CloudFront docs (`#Version`, `#Fields`, the docs example lines) | gzip, TSV, URL-encoded UA (decoded once), `cs(Cookie)`, status `000`, a trailing tab, truncated |
| `fastly-json.log` | Fastly | `fastly` | "Classic" syslog prefix (`<134>… cache-… name[pid]: `) + the JSON format from Fastly's logging docs (`request_user_agent`, `url`, `response_status`, …) | `(null)` for absent headers, `%z` offsets without a colon, truncated |
| `u_ex260929.log` | IIS | `iis` | Microsoft W3C docs example + the IIS 10 default `#Fields` | BOM, CRLF, `+` for spaces (lossy: a literal `+` in a UA becomes a space), fields re-declared after a restart, `cs(Cookie)`, `cs-username`, truncated |

Fastly has no fixed format: every service configures its own. We chose the JSON example Fastly documents, behind the Classic prefix. A syslog prefix (RFC 3164 "Classic" or RFC 5424) is stripped before any format, so syslog-framed nginx or Apache lines work as well.

ALB does not say how it escapes a `"` inside a User-Agent. We assume backslash escaping and raw UTF-8.

## Denominator (SCAN-1)

The parse rate is **parsed request records / request records**.

- **Request records** are the requests a line contains. That is one per line, except a Vercel JSON-array line, which holds several. A request record that is broken still counts in the denominator: a truncated last line, a line cut in half, a line in the wrong format.
- **Not requests**, so counted in neither the numerator nor the denominator: W3C `#` directives, Vercel build output and the second and later console lines of the same function request, and Caddy's non-access loggers. The scan reports these as `skipped_non_requests`, and SCAN-1 checks that number against the truth.
- **Parsed** means that method, target, status and User-Agent all equal the truth. It is not enough for a line to match a regex. SCAN-1 also requires the parse rate the scan reports to equal the rate that is actually correct.

## Classes (SCAN-2)

These are the Gate's rules for unsigned traffic (spec §11.5, `gate-core/src/agents.mjs`):

- **DECLARED**: the UA contains a published agent token. A token wins over an automation signal in the same UA.
- **SUSPECTED**: the UA contains an automation signal, or there is no UA (`-`, empty, Fastly `(null)`).
- **UNKNOWN**: everything else, humans included. This also covers formats with no UA field, which are counted separately as `no_user_agent_field`.
- **UNVERIFIED**: the request carried Web Bot Auth headers (`Signature-Input`, `Signature` or `Signature-Agent`; visible in Caddy, and in Cloudflare `RequestHeaders`). A log cannot verify a signature, so it is not attributable (draft App. C.1).
- A log never yields VERIFIED, SPOOFED or REVOKED. Only a Gate can.

## Route kinds and the critical number (SCAN-2)

Kinds follow `gate-core/src/route.mjs`:

1. The **deepest** path segment that names a kind decides. Examples: `/account/login` is login, `/my-account/orders` is checkout, `/api/cart/add` is checkout. For this check, segments are lowercased and a page extension such as `.php`, `.aspx` or `.html` is dropped.
2. Otherwise, a search query key (`q`, `query`, `search`, `s`, `k`, `keyword`, `term`) makes it **search**.
3. Otherwise, `/api/…`, `/graphql`, `/wp-json/…` or `/v1/…` is **api**. A static file extension, or a `/static/`, `/assets/` or `/_next/` prefix, is **asset**. Everything else is **browse**.
4. No path at all (`*`, `CONNECT host:443`, garbage) is **malformed**.

**Critical** means the kind is checkout, login, signup or account, **or** the method is POST, PUT, PATCH or DELETE on any route (spec §11.3 Pressure 2: 決済・ログイン・投稿).

**The fear number** is the count of requests that are automation, not VERIFIED, and on a critical route. `served` is the subset answered with a status from 1xx to 3xx.

## What may be printed (SCAN-3)

Scan output never contains a client IP, a query value, a cookie, a header value, a user name, or a path segment that could identify someone.

- Routes are printed only as strict templates. Identifiers become `:id`, `:uuid`, `:email`, `:handle`, `:hex` or `:token`. **Any word that is not a known route word becomes `:param`.** So a crawled profile such as `/users/zelda` is printed as `/users/:param`, however often bots fetched it. The known route words are the route-kind words plus the common-route vocabulary in `route.mjs`.
- File names are printed without directories, with IP addresses and long digit runs (account IDs) masked.
- The corpus plants canaries in every place a leak could come from: client IPs, XFF IPs, the LB node IP in the file name, query values, IDs, UUIDs, emails, JWTs, hex, tokens, percent-encoded names, usernames, handles, cookies, referers, `%u`, the AWS account ID. They are listed in each truth file under `canaries`.
- SCAN-3 runs the real CLI with every network and subprocess API trapped (`packages/scan/test/no-network.mjs`). It asserts zero attempts and zero canaries, for text and JSON output, for the whole directory, for each file, and for stdin.

## Throughput (SCAN-4)

`packages/scan/bench/scan4.mjs` generates 1 GiB of nginx `main` lines in a temp dir. Generation is not timed. It then times the real CLI end to end and checks that every line and every class was counted.
