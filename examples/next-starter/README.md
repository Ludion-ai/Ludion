# ludion next-starter

Minimal Next.js template for [`ludion-router`](https://www.npmjs.com/package/ludion-router).
It does one bounded, low-risk task — **polishing a short piece of text** — and
runs it **on-device** in the browser via WebGPU, with **no server and no API
key**. Adding your own provider as a fallback is a separate, optional step.

## Run it (on-device, zero setup)

```bash
# from this directory (it is standalone — not part of the monorepo workspace)
npm install
npm run dev   # http://localhost:3000 — no .env needed
```

On a WebGPU desktop the first run downloads the local model (progress is shown
via `onLocalLoadProgress`; it's cached after the first time), then the rewrite
runs entirely in the browser. The page shows the per-request decision log
(`target · rule_id · policy_version · ttft · tps`), a plain-language "why did
this run here?" note, and a session counter including **server calls avoided**.

In local-only mode, any request the policy routes to a server (long prompt, no
WebGPU, unsupported browser) throws a typed `LudionNoFallbackConfigured` and is
reported in the UI rather than executed — that's the cue to add the optional
fallback below.

What's in the box:

- `app/page.tsx` — creates `Ludion` in the browser with **no fallback**
  (local-only), streams the rewrite, and surfaces the real `_ludion` fields.
- `app/api/chat/route.ts` — the optional ~15-line relay (see next section).

## Optional: add a server fallback for production

This second step lets server-routed requests complete too — for slow devices,
long prompts, unsupported browsers, or local failures. The relay keeps your
provider key server-side; the browser only ever talks to your own origin.

1. Configure the relay's provider:

   ```bash
   cp .env.example .env.local   # set LLM_BASE_URL + LLM_API_KEY (server-side only)
   ```

2. In `app/page.tsx`, pass a `fallback` to `Ludion.create(...)` (an example is
   commented inline there):

   ```ts
   const ludion = await Ludion.create({
     fallback: { url: "/api/chat", model: "gpt-4o-mini" }, // your provider's model
     onLocalLoadProgress: (p) => setProgress(p.progress < 1 ? p.text : null),
   });
   ```

The relay (`app/api/chat/route.ts`) is the
[Next.js route-handler recipe](../../docs/recipes/nextjs-route-handler.md):
browser → same-origin `/api/chat` → your provider. No CORS, no client-side key.

Because that route holds your provider key, it ships with a **minimal abuse
guard** so it can't be used as an open public relay (which would let an attacker
page spend your credits from a victim's browser): it rejects cross-site requests
(Origin/Referer must match this deployment), caps the request body at 32 KB, and
requires a well-formed chat-completion body. Behind a proxy/CDN set `APP_ORIGIN`
(e.g. `https://your-app.com`) so the origin check is exact; otherwise it falls
back to the request `Host`. This is a starter-grade guard only — add rate
limiting and real auth before putting a real budget behind it.
