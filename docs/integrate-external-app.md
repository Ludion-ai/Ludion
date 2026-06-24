# Integrate ludion-router into your own app — from scratch

The one-true-path for building a **new** browser app and wiring `ludion-router`
into it end to end: install, wire the call into a UI handler, deploy a relay
that allows your own origin, and run it on localhost.

This is the standalone-app companion to the relay-only
[recipes](recipes/README.md) (which cover just the server side) and the
[production deploy runbook](production-deploy.md) (which covers taking the
Ludion *workspace* live, not your app). Everything below is the exact path
walked in a cold run — each step fixes a real point of friction, named.

> Routing model: requests run **on-device first** (WebGPU) and fall back to the
> **relay** (your server-side key) only when a request can't run on-device. The
> relay is what makes server-routed requests work without putting your provider
> key in the browser.

---

## 0. What you'll end up with

```
your-app/
  index.html
  main.ts          # UI + wiring (the form handler calls ask())
  ai.ts            # new OpenAI({ baseURL: <relay>, apiKey: <relay token> })
  package.json     # deps: vite (bundler) + ludion-router
  relay/           # a copy of the Cloudflare Worker relay you deploy
    wrangler.toml
    src/...
```

The browser talks to **your relay**; the relay talks to **your provider**; the
provider key lives **only** in the relay's server-side secret.

---

## 1. Install — and you need a bundler

```bash
npm install ludion-router
```

`ludion-router` is an npm package you import by a **package subpath**:

```ts
import OpenAI from "ludion-router/openai";
```

**This is not a CDN URL.** A bare `index.html` opened from the filesystem
cannot resolve a bare specifier like `ludion-router/openai`, and browsers can't
execute `.ts` directly. You need a bundler/dev-server. Vite is the smallest
setup:

```jsonc
// package.json
{
  "type": "module",
  "scripts": { "dev": "vite" },
  "devDependencies": { "vite": "^5.4.0" },
  "dependencies": { "ludion-router": "^0.3.1" }
}
```

> **Friction this fixes:** opening `index.html` directly, or pasting a CDN
> `https://esm.run/...` URL, both fail. The import is a package subpath,
> resolved at build time by your bundler.

---

## 2. Wire the call into a UI handler — NOT top-level await

Put the client construction in its own module. The `apiKey` here is your
**relay token** (low-value, client-visible by design — see step 4), never your
provider key:

```ts
// ai.ts
import OpenAI from "ludion-router/openai";

const RELAY_URL = "https://your-relay.<account>.workers.dev"; // from step 4
const RELAY_TOKEN = "<your relay token>";                     // from step 4

const client = new OpenAI({
  baseURL: RELAY_URL, // your relay; ludion appends /chat/completions
  apiKey: RELAY_TOKEN, // authenticates to YOUR relay only
});

// Call this from a UI event — a click, a form submit — never at module top level.
export async function ask(prompt: string): Promise<string> {
  const res = await client.chat.completions.create({
    model: "claude-3-5-sonnet-latest", // your provider's REAL model id (see step 3)
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content ?? "";
}
```

Then invoke it on user action:

```ts
// main.ts
import { ask } from "./ai";

const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const reply = await ask(input.value); // runs on send, not on import
  // ...render reply...
});
```

> **Friction this fixes (the single most confusing one):** a runnable one-shot
> snippet — `const res = await client.chat.completions.create(...)` at the top
> of a module — runs **at import time**. If that first call fails (no relay yet,
> CORS, bad model id), your whole app crashes on load. Wrapping the call in a
> function that a UI handler invokes means a failed request is a failed request,
> not a dead app.

---

## 3. Model id — it is passed to your provider verbatim

The string you put in `model:` is **forwarded to your provider unchanged**.
There is no logical-id translation on the fallback path (the caller's `model`
is the fallback target, sent as-is to your relay → your provider).

So you must use **your provider's real model id**:

| Use this (real provider id) | NOT this (ludion registry logical id) |
|---|---|
| `claude-3-5-sonnet-latest` | `claude-sonnet` |
| `gpt-4o` | (logical handle) |

A logical handle like `claude-sonnet` is an internal ludion registry id; passed
to a provider it is rejected as an unknown model. If you copied a model string
from a ludion surface, double-check it is the provider's real id.

> **Friction this fixes:** the request reaching the provider with a model name
> the provider has never heard of, failing with an opaque upstream error.

---

## 4. Deploy a relay that allows YOUR origin

The relay keeps your provider key server-side. Copy the canonical worker into
your app and deploy it:

```bash
# from your app root
cp -r path/to/ludion/relays/cloudflare-worker ./relay
cd relay
```

Edit `relay/wrangler.toml`:

```toml
name = "your-relay"                                # any name you like
# ...
[vars]
UPSTREAM_BASE_URL = "https://api.anthropic.com/v1" # your provider's OpenAI-compatible endpoint
ALLOWED_ORIGINS  = "http://localhost:5173"         # YOUR dev origin (Vite default) — REQUIRED
```

**`ALLOWED_ORIGINS` must include your own dev origin.** A browser call from
`http://localhost:5173` to a relay that does not list that origin dies on CORS
before it ever reaches your provider. Add every origin your app runs on, comma
separated, no trailing slash — e.g.
`http://localhost:5173,https://your-app.example`.

> This is the opposite of the in-workspace default, which lists the ludion
> playground origin so the workspace's own verify probe passes. For your app,
> the playground origin is irrelevant — you want **your** origins.

Then set the secrets and deploy **from inside the `relay/` directory**:

```bash
# still inside ./relay
npx wrangler secret put PROVIDER_API_KEY   # your real provider key — server-side only
npx wrangler secret put RELAY_TOKEN        # a low-value gate token the browser sends
npx wrangler deploy
```

> **Friction this fixes #1 (CLI):** run `wrangler deploy` from the directory
> that contains `wrangler.toml`. From your app root, wrangler can't find the
> Worker config and fails with "Required Worker name missing" (and may try to
> treat your app's Vite config as the Worker).
>
> **Friction this fixes #2 (CORS):** without your dev origin in
> `ALLOWED_ORIGINS`, every request from localhost is blocked at the browser.

Deploy prints your relay URL (e.g.
`https://your-relay.<account>.workers.dev`). Put it in `ai.ts` as `RELAY_URL`,
and the `RELAY_TOKEN` you set as the secret as `RELAY_TOKEN`.

The rate-limit block ships on by default; if `wrangler deploy` rejects the
`[[ratelimits]]` block on your wrangler version, see the relay's
[README](../relays/cloudflare-worker/README.md) escape hatch.

---

## 5. Two config paths — which one you use

There are two ways `ludion-router` learns your relay URL + token, and they are
**not interchangeable**:

| Path | What it is | When to use |
|---|---|---|
| **Constructor args in code** — `new OpenAI({ baseURL, apiKey })` | Values live in your app's source (as in step 2). | **Integrating your own app.** This is your path. |
| **`ludion.config.v1` JSON (drop-in config)** | A JSON blob persisted in `localStorage` under the **ludion.ai workspace origin**. | Only for code running on the ludion.ai workspace origin. |

The drop-in `ludion.config.v1` you may see generated in the ludion workspace is
stored in `localStorage` **for the ludion.ai origin only**. Your app runs on a
different origin (`http://localhost:5173`, then your production origin), so it
**cannot read that storage** — the values would simply be absent. That is why
your own app passes the relay URL and token **directly as constructor
arguments** in code, as shown in step 2.

> **Friction this fixes:** copying the `ludion.config.v1` JSON into your app and
> expecting it to "just work." It can't — your origin has no access to the
> workspace-origin storage. Use constructor args.

---

## 6. Run it

```bash
npm run dev        # vite, serves http://localhost:5173
```

Open `http://localhost:5173`, type a message, send. The request goes
on-device-first; where it can't run on-device it falls back through your relay
to your provider. Each response carries `res._ludion` — the decision log
(target, rule_id, policy_version, timing).

If a call fails, walk back up:

- **CORS error in the console** → your dev origin isn't in `ALLOWED_ORIGINS`
  (step 4). Re-deploy the relay with it added.
- **401 from the relay** → the `RELAY_TOKEN` in `ai.ts` doesn't match the secret
  you set (step 4).
- **Upstream error / unknown model** → wrong model id (step 3) or wrong
  `UPSTREAM_BASE_URL` for your provider (step 4).
- **App dead on load** → a call is at module top level instead of in a handler
  (step 2).

---

## Recap — the six things that bite

1. **Bundler required.** Bare `index.html` / `.ts` won't run; the import is a
   package subpath, not a CDN URL.
2. **Wire into a handler, not top-level await** — a failed call should fail the
   request, not the app.
3. **Real provider model id** — the model string is passed through verbatim;
   the registry logical id is rejected by the provider.
4. **`ALLOWED_ORIGINS` must list your own dev origin** (`http://localhost:5173`)
   or every browser call dies on CORS.
5. **Constructor args, not the workspace `ludion.config.v1`** — that storage
   belongs to the ludion.ai origin, not yours.
6. **Deploy from the relay directory** — `wrangler deploy` needs to see
   `wrangler.toml`.
