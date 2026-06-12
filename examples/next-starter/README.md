# ludion next-starter

Minimal Next.js template for [`ludion-router`](https://www.npmjs.com/package/ludion-router)
with the relay proxy already wired up: on-device WebGPU inference when the
policy allows it, your own OpenAI-compatible provider when it doesn't — and
the provider key never leaves the server.

```bash
# from this directory (it is standalone — not part of the monorepo workspace)
npm install
cp .env.example .env.local   # put your LLM_BASE_URL + LLM_API_KEY there
npm run dev                  # http://localhost:3000
```

What's in the box:

- `app/api/chat/route.ts` — the ~15-line relay
  ([recipe](../../docs/recipes/nextjs-route-handler.md)): browser →
  same-origin `/api/chat` → your provider. No CORS, no client-side key.
- `app/page.tsx` — a minimal chat that creates `Ludion` in the browser,
  streams the answer, and prints the per-request decision log
  (`target · rule_id · policy_version`).

On a WebGPU desktop the first prompt downloads the local model (progress is
shown via `onLocalLoadProgress`); routed-to-server prompts go through your
relay. Change `SERVER_MODEL` in `app/page.tsx` to whatever your provider
serves.
