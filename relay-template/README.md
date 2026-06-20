# Ludion fallback relay

Deploy this relay to your own Cloudflare account, paste its URL into your Ludion
workspace, and your provider API key stays in a Worker secret instead of the
browser. It is an OpenAI-compatible passthrough: the browser calls the relay,
the relay injects your provider key from a server-side secret and forwards the
request upstream, and streams the response straight back.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ludion-ai/ludion-relay-template)

## One-click deploy

Click the button. Cloudflare clones this template into your account and prompts
you for four values:

- `PROVIDER_API_KEY` (secret) — your real provider key. You enter it into
  Cloudflare. It never reaches Ludion.
- `RELAY_TOKEN` (secret) — paste the token shown in your Ludion workspace. It
  must match exactly, or the relay returns 401.
- `UPSTREAM_BASE_URL` (var) — your provider's OpenAI-compatible base URL. The
  workspace shows you the right value for your fallback model.
- `ALLOWED_ORIGINS` (var) — your app's origin. Comma-separated, no trailing
  slash, never `*`.

The template deploys with no code edits. After it is live, copy the Worker URL
and paste it back into the workspace.

## What the relay protects, and what it does not

Read this before you rely on it. Do not overstate what you get.

- What it protects: your provider key stays on the server and never reaches the
  browser. A leaked provider key grants full provider-account access (every
  model, your billing, your other apps). The relay puts it out of reach. That is
  the real and only strong claim.
- What it does not protect by itself: the relay token is visible to anyone using
  your app (view-source, network tab). CORS does not stop a non-browser caller
  (curl or a server ignores it). So the endpoint is only as protected as its
  token plus rate limiting.
- For production: the template ships rate limiting on by default (60 requests
  per minute per IP). Add your own per-user auth in front of the relay if you
  need more. Rotate `RELAY_TOKEN` if it leaks.

## Which models work

This is a pure passthrough. It does not translate request shapes, so the
upstream must speak the OpenAI `/chat/completions` shape.

- OpenAI direct: `gpt-4o`, `gpt-4o-mini`. Set
  `UPSTREAM_BASE_URL = https://api.openai.com/v1`.
- Anthropic (Claude): `claude-sonnet`, `claude-haiku`. Point `UPSTREAM_BASE_URL`
  at Anthropic's OpenAI-compatible endpoint, not the native Anthropic API. The
  native API uses a different request shape and will not work through pure
  passthrough.
- Any other provider: use its OpenAI-compatible endpoint, not its native API.

## Prefer the CLI?

You can deploy from a terminal instead of the button:

```sh
# set UPSTREAM_BASE_URL and ALLOWED_ORIGINS in wrangler.jsonc, then:
npx wrangler secret put PROVIDER_API_KEY   # your real provider key, server-side only
npx wrangler secret put RELAY_TOKEN        # paste the token from your workspace
npx wrangler deploy
```

## Open relay (advanced, unsafe)

Setting `RELAY_OPEN = "true"` disables the token gate entirely, leaving an open
proxy to your provider key for anyone who learns the URL. Only do this if you run
your own auth in front of the relay. The default is token-required.

## Rate limit

The template enables the native Workers rate-limiting binding in
`wrangler.jsonc` (60 requests per 60 seconds per client IP, returns 429 over the
cap). Limiting is approximate and per-colo, so treat it as an abuse guard, not an
exact quota. `period` accepts only 10 or 60 seconds. Adjust `limit`, or remove
the `ratelimits` block to disable.

## Local check

```sh
npm install
npm test          # the full behavior suite against an injected mock upstream
npm run dev       # wrangler dev against a local OpenAI-compatible mock
```
