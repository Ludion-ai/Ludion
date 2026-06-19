# Ludion fallback relay (Cloudflare Worker)

This is the canonical fallback relay. It stands in for the "write your own
fallback server" step: deploy it once, point Ludion's config at its URL, and the
provider API key lives in a Worker secret instead of the browser.

It is a pure OpenAI-compatible passthrough. The browser calls the relay, the
relay injects your provider key from a server-side secret and forwards the
request to your upstream, and streams the response straight back. The browser
never holds the provider key.

## What it does and does not do

- Injects `PROVIDER_API_KEY` (a Worker secret) as the upstream `Authorization`
  header. The browser sends no provider key.
- Requires a relay token by default. A request without a valid
  `Authorization: Bearer <RELAY_TOKEN>` is rejected with 401 before the upstream
  or the provider secret is touched.
- Forwards the OpenAI-shaped request to `UPSTREAM_BASE_URL` + `/chat/completions`
  unchanged, and streams the response back token by token (SSE intact).
- Handles CORS for your app origin (defense-in-depth, not the auth boundary).
- v1 is pure passthrough. It does not translate provider request shapes. Use it
  with an OpenAI-compatible endpoint.

## What the relay protects, and what it does not

Read this before deploying. Do not overstate what you are getting.

- What it protects: your provider key stays on the server and never reaches the
  browser. A leaked provider key grants full provider-account access (every
  model, your billing, your other apps). The relay puts it out of reach. That is
  the real and only strong claim: it keeps your key off the client.
- What it does not protect by itself: the relay token is visible to anyone using
  your app (view-source, network tab). CORS does not stop a non-browser caller
  (curl or a server ignores it). So the relay endpoint is only as protected as
  its token plus rate limiting. "Keeps your key off the client" is true. "Your
  relay is secure" is not.
- What to add for production: a rate limit (see below) and/or your own per-user
  auth in front of the relay. Rotate `RELAY_TOKEN` if it leaks
  (`wrangler secret put RELAY_TOKEN` again).

## Which registry models work through pure passthrough

v1 does not translate request shapes, so the upstream must speak the OpenAI
`/chat/completions` shape. The workspace offers Claude models, so set `baseURL`
carefully:

- OpenAI direct: `gpt-4o`, `gpt-4o-mini`. Set
  `UPSTREAM_BASE_URL = https://api.openai.com/v1`.
- Anthropic (Claude): `claude-sonnet`, `claude-haiku`. Point `UPSTREAM_BASE_URL`
  at Anthropic's OpenAI-compatible endpoint, NOT the native Anthropic API. The
  native API uses a different request shape and will not work through pure
  passthrough.
- Google (Gemini): `gemini-flash` is unverified in the registry and excluded
  from the picker. If you wire it yourself, it likewise needs an
  OpenAI-compatible endpoint, not the native Google API.

## Deploy

1. Set the upstream and your app origin in `wrangler.toml`:

   ```toml
   [vars]
   UPSTREAM_BASE_URL = "https://api.openai.com/v1"
   ALLOWED_ORIGINS = "https://your-app.example"
   ```

   `ALLOWED_ORIGINS` is a comma-separated list with no trailing slash. Do not use
   `*`. CORS is a browser containment line, not authentication.

2. Put the provider key in a secret. It never appears in the repo or the browser:

   ```sh
   npx wrangler secret put PROVIDER_API_KEY
   ```

3. Set the relay token. It is required by default and is the auth boundary:

   ```sh
   npx wrangler secret put RELAY_TOKEN
   ```

4. Deploy:

   ```sh
   npx wrangler deploy
   ```

### Rate limit (optional, recommended for production)

The token stops casual abuse, but a leaked token is still a token. Add a rate
limit so a leaked token cannot drain your provider budget. The template uses the
native Workers rate-limiting binding because it needs no resource creation, so
enabling it stays a one-step deploy: uncomment the block in `wrangler.toml` and
`wrangler deploy`.

```toml
[[ratelimits]]
binding = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
```

The relay counts per client IP and returns 429 over the cap. Defaults to 60
requests per 60 seconds. Adjust `limit` to taste; `period` accepts only 10 or 60
seconds. Limiting is approximate and per-colo, so treat it as an abuse guard, not
an exact quota. Remove the block to disable. If a deploy rejects the binding,
check the binding syntax against your wrangler version's docs.

### Open relay (advanced, unsafe)

Setting `RELAY_OPEN = "true"` disables the token gate entirely, leaving an open
proxy to your provider key for anyone who learns the URL. Only do this if you run
your own auth in front of the relay. The default is token-required.

## Point Ludion at the relay

Write this into `ludion.config.v1` (the demo's settings UI does this, or call
`writeDropinConfig` directly). There is no provider key here:

```json
{
  "config_version": 1,
  "fallback": {
    "baseURL": "https://ludion-fallback-relay.<your-account>.workers.dev",
    "model": "gpt-4o-mini",
    "apiKey": "<RELAY_TOKEN>"
  }
}
```

- `baseURL` is the deployed Worker URL. Ludion appends `/chat/completions`.
- `apiKey` carries the relay token, not the provider key. It is required (the
  relay rejects requests without it unless you set `RELAY_OPEN`).
- This config flows through Ludion's existing live config path. A change takes
  effect on the next request with no page reload.

## The relay-token tradeoff (read this)

The provider key is gone from the browser. That is the point of the relay, and
it is the real security win: a leaked provider key grants full provider-account
access (every model, your billing, your other apps), and it is now out of reach.

The relay token still lives client-side under `ludion.config.v1`, so it has the
same exposure any client-side value has (an XSS on your origin can read it). The
difference is blast radius: a leaked relay token only lets someone spend through
your relay. It is rotatable (`wrangler secret put RELAY_TOKEN` again),
origin-scoped via `ALLOWED_ORIGINS`, rate-limitable, and grants no
provider-account access. Treat it as a low-value gate, not as custody.

Holding no client secret at all requires real user auth in front of the relay.
That is a later piece of the workspace, not this template.

## Local check

Run a mock upstream and the relay:

```sh
# any OpenAI-compatible mock on :8787/v1, then in this directory:
npx wrangler dev
```

Confirm against the running Worker:

- An `OPTIONS` preflight from your origin returns the CORS headers.
- A `POST /chat/completions` with no relay token is rejected with 401.
- A `POST /chat/completions` with the relay token and no provider key succeeds,
  and the upstream receives `Authorization: Bearer <PROVIDER_API_KEY>`.
- A streamed request arrives chunk by chunk, not all at once.
- The response is OpenAI-shaped.

The automated suite (`pnpm --filter ludion-fallback-relay test`) covers all of
the above against an injected mock upstream.

## Operator gate (do not run here)

A real `wrangler deploy` to Cloudflare and a real request against a real provider
key are the operator's gate. The steps are exactly the deploy steps above, run
with real values.
