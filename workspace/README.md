# Ludion workspace backend (2a: auth + config persistence)

This is the login-gated foundation the workspace UI (2b) sits on. A developer logs
in with GitHub, and their non-secret Ludion config persists server-side, keyed by
their GitHub user id. The UI itself (model picker, relay generation, monitoring)
is 2b and is not here.

It runs as same-origin Cloudflare Pages Functions on the demo project, so the
session cookie is httpOnly and SameSite=Lax with no CORS. All logic lives in this
package (`src/`) and is unit-tested; `demo/functions/auth/*` and
`demo/functions/api/*` are thin adapters that call it.

## The storage invariant (hard rule)

The server stores only non-secret routing config. It never receives or stores the
provider API key, the relay token, or any prompt/output content. The stored shape
has no field that can hold a secret or content, and writes reject unknown fields
and any secret/content-shaped key. The relay token stays client-side in the
browser's `ludion.config.v1` and is never sent to a Ludion endpoint.

Stored shape (server, KV):

```json
{ "config_version": 1, "fallback": { "baseURL": "...", "model": "..." }, "relayUrl": "..." }
```

Client shape (`ludion.config.v1`, browser only) additionally carries
`fallback.apiKey` (the relay token). 2b maps stored config to client config by
adding that token in the browser. The token never travels server-ward.

## Routes

- `GET /auth/login` redirects to GitHub authorize and sets a one-shot state cookie.
- `GET /auth/callback` verifies state, exchanges the code for a token, reads the
  GitHub user id and handle, mints a signed session cookie, and discards the
  GitHub token. Nothing from GitHub is stored except the id and handle.
- `POST /auth/logout` clears the session cookie.
- `GET /api/config` returns the current user's stored config, or an empty default.
- `PUT /api/config` validates and stores the config. A payload with a key, token,
  or content field is rejected with 400 and nothing is written.
- Any `/api/*` request without a valid session is rejected with 401.

## Local check

```sh
# in this directory, with .dev.vars holding a throwaway dev OAuth app + secrets:
npx wrangler dev
```

The automated suite proves the flow without a live GitHub:

```sh
pnpm --filter ludion-workspace test
```

It mocks the GitHub exchange and covers login redirect, callback session minting
(with the GitHub token discarded), state-mismatch rejection, the `/api/*` 401
gate, config round-trip, per-user scoping, and rejection of secret/content fields.

## Operator gate (Lattice — do not run from CI)

1. Register a GitHub OAuth app. Set the callback URL to
   `https://<your-demo-domain>/auth/callback`.
2. Set the Pages secrets on the demo project:

   ```sh
   npx wrangler pages secret put GITHUB_CLIENT_ID
   npx wrangler pages secret put GITHUB_CLIENT_SECRET
   npx wrangler pages secret put SESSION_SECRET   # any long random string
   ```

3. Create and bind the KV namespace (binding name `WORKSPACE_KV`):

   ```sh
   npx wrangler kv namespace create WORKSPACE_KV
   # paste the printed id into demo/wrangler.toml
   ```

4. Deploy the Pages project, then test a real login and a `/api/config` round-trip
   in the browser.

## What 2b's UI will call

- `GET /api/config` to load the developer's saved fallback/model/relayUrl.
- `PUT /api/config` to save edits (non-secret only).
- `/auth/login` and `/auth/logout` for the session.
- The relay token stays in the browser; 2b writes it into `ludion.config.v1`
  client-side and never sends it here.
