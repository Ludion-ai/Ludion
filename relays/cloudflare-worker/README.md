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
- Forwards the OpenAI-shaped request to `UPSTREAM_BASE_URL` + `/chat/completions`
  unchanged, and streams the response back token by token (SSE intact).
- Handles CORS for your app origin.
- v1 is pure passthrough. It does not translate provider request shapes. Use it
  with an OpenAI-compatible endpoint.

### Which registry models work through pure passthrough

- OpenAI models work directly (`UPSTREAM_BASE_URL = https://api.openai.com/v1`).
- Anthropic, Google, and others work only through an OpenAI-compatible endpoint
  (for example Anthropic's compatibility endpoint). Point `UPSTREAM_BASE_URL` at
  that endpoint. Native (non-OpenAI) request shapes are not translated here.

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

3. Recommended: set a relay token so only your app can spend through the relay:

   ```sh
   npx wrangler secret put RELAY_TOKEN
   ```

4. Deploy:

   ```sh
   npx wrangler deploy
   ```

## Point Ludion at the relay

Write this into `ludion.config.v1` (the demo's settings UI does this, or call
`writeDropinConfig` directly). There is no provider key here:

```json
{
  "config_version": 1,
  "fallback": {
    "baseURL": "https://ludion-fallback-relay.<your-account>.workers.dev",
    "model": "gpt-4o-mini",
    "apiKey": "<RELAY_TOKEN, if you set one>"
  }
}
```

- `baseURL` is the deployed Worker URL. Ludion appends `/chat/completions`.
- `apiKey` is the relay token, not the provider key. Omit it if you did not set
  `RELAY_TOKEN`.
- This config flows through Ludion's existing live config path. A change takes
  effect on the next request with no page reload.

## The relay-token tradeoff (read this)

The provider key is gone from the browser. That is the point of the relay, and
it is the real security win: a leaked provider key grants full provider-account
access (every model, your billing, your other apps), and it is now out of reach.

The relay token, if you use one, still lives client-side under
`ludion.config.v1`, so it has the same exposure any client-side value has (an XSS
on your origin can read it). The difference is blast radius: a leaked relay token
only lets someone spend through your relay. It is rotatable
(`wrangler secret put RELAY_TOKEN` again), origin-scoped via `ALLOWED_ORIGINS`,
and grants no provider-account access. Treat it as a low-value gate, not as
custody.

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
- A `POST /chat/completions` with no provider key succeeds, and the upstream
  receives `Authorization: Bearer <PROVIDER_API_KEY>`.
- A streamed request arrives chunk by chunk, not all at once.
- The response is OpenAI-shaped.

The automated suite (`pnpm --filter ludion-fallback-relay test`) covers all of
the above against an injected mock upstream.

## Operator gate (do not run here)

A real `wrangler deploy` to Cloudflare and a real request against a real provider
key are the operator's gate. The steps are exactly the deploy steps above, run
with real values.
