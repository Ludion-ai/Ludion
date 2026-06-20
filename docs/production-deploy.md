# Ludion production deploy runbook

How to take the built workspace live: GitHub OAuth login, signed session, KV
config persistence, and the canonical fallback relay. Every name, URL, and
command below is the exact one the code reads — no shorthand.

You (the operator) run all of this against your own GitHub and Cloudflare
accounts. None of it is automated in CI (`.github/workflows/ci.yml` only
typechecks, tests, and verifies the build — it never deploys).

## What the code actually reads (extracted, exact)

| Thing | Exact value | Where in code |
|---|---|---|
| KV binding | `WORKSPACE_KV`, key shape `user:{uid}` | `workspace/src/handler.ts` |
| Pages secrets | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` | `workspace/src/handler.ts` |
| OAuth authorize | `https://github.com/login/oauth/authorize` | `workspace/src/handler.ts` |
| OAuth token exchange | `https://github.com/login/oauth/access_token` (POST, JSON) | `workspace/src/handler.ts` |
| OAuth user read | `https://api.github.com/user` | `workspace/src/handler.ts` |
| OAuth scope | `read:user` | `workspace/src/handler.ts` |
| Callback path | `/auth/callback` | `workspace/src/handler.ts` |
| Function routes | `/auth/login` GET · `/auth/callback` GET · `/auth/logout` POST · `/api/me` GET · `/api/config` GET/PUT | `workspace/src/handler.ts` |
| Post-login redirect | `<origin>/app` | `workspace/src/handler.ts` |
| Post-logout redirect | `<origin>/` | `workspace/src/handler.ts` |
| `/api/me` unauth response | `401` `{"error":{"code":"unauthorized","message":"login required"}}` | `workspace/src/handler.ts` |
| Session cookie | `ludion_session` — HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=604800 (7 days) | `workspace/src/session.ts` |
| OAuth state cookie | `ludion_oauth_state` — same attributes, Max-Age=600 | `workspace/src/session.ts` |
| Session scheme | stateless HMAC-SHA256, `<body>.<sig>` base64url, signed by `SESSION_SECRET` | `workspace/src/session.ts` |
| Relay secrets | `PROVIDER_API_KEY`, `RELAY_TOKEN` (required by default) | `relays/cloudflare-worker/src/relay.ts` |
| Relay vars | `UPSTREAM_BASE_URL`, `ALLOWED_ORIGINS` | `relays/cloudflare-worker/src/relay.ts` |
| Relay route | `POST /chat/completions` (path appended to `UPSTREAM_BASE_URL`) | `relays/cloudflare-worker/src/relay.ts` |
| Pages project | `name = "ludion-demo"`, output `dist`, functions in `demo/functions/` | `demo/wrangler.toml` |
| Relay Worker | `name = "ludion-fallback-relay"`, `main = "src/index.ts"` | `relays/cloudflare-worker/wrangler.toml` |

Important: the redirect URIs are computed from the incoming request origin, so
they auto-match whatever domain Pages serves. The domain is pinned in only two
operator-set places — the GitHub OAuth app callback URL (§A) and the relay
`ALLOWED_ORIGINS` (§F). This runbook assumes the production domain is
`https://ludion.ai`; substitute your actual Pages domain everywhere if it
differs.

Prereqs: Node 22, `pnpm@9.15.9` (the repo's pinned version), and
`npx wrangler` (Cloudflare CLI) authenticated to your account
(`npx wrangler login`).

---

## A. Create the GitHub OAuth App

1. GitHub → your profile → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Fill in:
   - Application name: `Ludion` (anything; shown on the consent screen).
   - Homepage URL: `https://ludion.ai`
   - Authorization callback URL: `https://ludion.ai/auth/callback`
     (exactly this path — the handler builds `redirect_uri = <origin>/auth/callback`).
3. Register, then on the app page:
   - Copy the **Client ID** → this is `GITHUB_CLIENT_ID`.
   - Click **Generate a new client secret**, copy it → this is `GITHUB_CLIENT_SECRET`
     (shown once; store it in a password manager).
4. Scope: the app requests **`read:user`** only. GitHub's consent screen will
   show read-only access to profile info. The access token is used once in the
   callback to read the user id, then discarded — it is never stored or logged.

---

## B. Set the Pages secrets

Three secrets on the `ludion-demo` Pages project. All three are **secrets**
(not plaintext vars): the client secret and the session key are sensitive, and
the client id is treated as a secret here too for uniformity.

Generate a strong session signing key first:

```sh
openssl rand -hex 32
```

Set all three (production environment). Either the dashboard
(Pages project → Settings → Environment variables → Production → add as
**encrypted**) or wrangler:

```sh
npx wrangler pages secret put GITHUB_CLIENT_ID --project-name ludion-demo
npx wrangler pages secret put GITHUB_CLIENT_SECRET --project-name ludion-demo
npx wrangler pages secret put SESSION_SECRET --project-name ludion-demo
```

Each command prompts for the value (paste, enter). If you also test the flow on
Pages **preview** deployments, repeat with the preview environment (dashboard:
the Preview column; wrangler defaults to production — use the dashboard for
preview).

Do not commit any of these values. `SESSION_SECRET` must stay stable: rotating
it invalidates every live session (everyone is logged out).

---

## C. Create and bind the KV namespace

The config store the `/api/config` Functions read and write, keyed `user:{uid}`.

1. Create it:

   ```sh
   npx wrangler kv namespace create WORKSPACE_KV
   ```

   This prints a namespace **id** (a 32-hex string). Copy it.

2. Bind it to the Pages project under the binding name **`WORKSPACE_KV`**
   (the code reads exactly this). Two ways — pick one:

   - **Dashboard (recommended, no id in the repo):** Pages project → Settings →
     Functions → KV namespace bindings → Add → Variable name `WORKSPACE_KV` →
     select the namespace you just created. Add it for Production (and Preview
     if you test there).

   - **wrangler.toml (local only, do not commit the id):** `demo/wrangler.toml`
     already contains the binding stanza with a placeholder:

     ```toml
     [[kv_namespaces]]
     binding = "WORKSPACE_KV"
     id = "REPLACE_WITH_KV_NAMESPACE_ID"
     ```

     Replace `REPLACE_WITH_KV_NAMESPACE_ID` with the real id **locally** for a
     `wrangler pages deploy`, but never commit it (the id stays out of git).

---

## D. Deploy the Pages site + Functions

The repo configures Pages (`demo/wrangler.toml`: `pages_build_output_dir =
"dist"`, Functions in `demo/functions/`) but pins **no** deploy automation. Pick
one mechanism:

- **Manual deploy with wrangler (unambiguous, matches the committed config):**

  ```sh
  pnpm install --frozen-lockfile
  pnpm --filter ludion-demo build      # builds demo/dist (runs gen-qr then vite build)
  cd demo
  npx wrangler pages deploy            # reads wrangler.toml: uploads dist + bundles functions/
  ```

- **Git-connected Pages (auto-build on push):** in the Cloudflare dashboard,
  create/connect the Pages project to this repo with:
  - Production branch: `main`
  - Build command: `pnpm --filter ludion-demo build`
  - Build output directory: `demo/dist`
  - Root directory: repo root (leave default) — `pnpm install` runs the
    workspace, and the build emits `demo/dist`.

  A push to `main` then builds and deploys. (The secrets from §B and the KV
  binding from §C are project settings; set them once regardless of mechanism.)

**Confirm the Functions are live** — hit the unauthenticated identity endpoint:

```sh
curl -i https://ludion.ai/api/me
```

Expect exactly:

```
HTTP/2 401
content-type: application/json
{"error":{"code":"unauthorized","message":"login required"}}
```

A 401 with that JSON body means the Functions are deployed and routing. An HTML
404 or the static page instead means the Functions did not bundle — re-check the
deploy mechanism (Functions must ship from `demo/functions/`).

---

## E. Verify the live auth + config path

1. Open `https://ludion.ai/`, click **Open workspace** (→ `/app`). With no
   session, the workspace redirects to `/auth/login`, which 302s to GitHub's
   authorize page.
2. Approve the `read:user` consent. GitHub redirects to
   `https://ludion.ai/auth/callback?code=...&state=...`. The handler verifies
   the state cookie, exchanges the code, reads your user id, mints the
   `ludion_session` cookie, and **redirects to `/app`** — you land authenticated
   on the workspace (this confirms the post-login `/app` redirect).
3. In the workspace, select a fallback model and paste a relay URL (the Relay
   section generates the `RELAY_TOKEN` you will use in §F). Then **reload the
   page**. The selection and relay survive the reload → KV write + read both
   work (`PUT /api/config` then `GET /api/config`, keyed `user:{your-uid}`).
4. Storage-invariant sanity check (prod confirmation of behavior the server
   already enforces): in DevTools → Network, inspect the `PUT /api/config`
   request body. It carries only `{ config_version, fallback: { baseURL?,
   model? }, relayUrl? }` — **no apiKey, no token, no provider key, no
   prompt/output content**. The relay token lives only in this browser
   (localStorage `ludion.config.v1` as `fallback.apiKey`); it never goes
   server-ward. (The server re-validates and rejects any secret-shaped field
   regardless.)
5. Log out (POST `/auth/logout`) → the `ludion_session` cookie is cleared and
   you return to `/`.

---

## F. Deploy the production relay

The fallback relay holds your real provider key server-side; the browser only
ever sends the low-value `RELAY_TOKEN`.

1. In `relays/cloudflare-worker/wrangler.toml`, set the two `[vars]`:
   - `UPSTREAM_BASE_URL` = your OpenAI-compatible provider base, e.g.
     `https://api.openai.com/v1` (the relay appends `/chat/completions`).
   - `ALLOWED_ORIGINS` = `https://ludion.ai` (comma-separated if more than one;
     no trailing slash; never `*`). This is defense-in-depth, not the auth
     boundary.

2. Set the secrets (run from `relays/cloudflare-worker/`):

   ```sh
   npx wrangler secret put PROVIDER_API_KEY   # your real provider API key
   npx wrangler secret put RELAY_TOKEN        # the token the workspace generated in §E.3
   ```

   The `RELAY_TOKEN` you set here **must equal** the token shown in the
   workspace Relay section (stored client-side as `fallback.apiKey` and sent as
   `Authorization: Bearer <RELAY_TOKEN>`). If they differ, fallback requests get
   401 from the relay. Leave `RELAY_OPEN` commented — uncommenting it disables
   the token gate and leaves an open proxy to your provider key.

3. Deploy:

   ```sh
   npx wrangler deploy
   ```

   Note the deployed URL (e.g. `https://ludion-fallback-relay.<account>.workers.dev`).
   This is the relay URL you paste into the workspace Relay section.

4. One real fallback request end-to-end: in the workspace, send a request the
   policy routes to **server** (e.g. a long prompt, or any request on a device
   without WebGPU). The decision strip shows target `SERVER`, and the response
   streams back — confirming the browser → relay → provider path. The provider
   key never left the Worker.

5. Abuse check — confirm fail-closed (the token, not CORS, is the boundary):

   ```sh
   curl -i -X POST \
     https://ludion-fallback-relay.<account>.workers.dev/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"gpt-4o-mini","messages":[]}'
   ```

   With no `Origin` and no `Authorization`, expect exactly:

   ```
   HTTP/2 401
   {"error":{"code":"unauthorized","message":"missing or invalid relay token"}}
   ```

   A non-browser caller sends no Origin and ignores CORS, yet is still refused —
   the relay token gate holds. (If `RELAY_TOKEN` is unset, the relay fails closed
   with `500 misconfigured` rather than silently becoming an open proxy.)

   Optional but recommended for production: enable the native per-IP rate limit
   by uncommenting the `[[ratelimits]]` block in the relay `wrangler.toml` and
   redeploying.

---

## Done

- `https://ludion.ai/` is the public landing; `/app` is the real, auth-gated
  workspace; `/demo` is the playground.
- Login, session, and per-user KV config persistence work for real users.
- The canonical relay serves fallback requests with the provider key held
  server-side and the token gate fail-closed.
