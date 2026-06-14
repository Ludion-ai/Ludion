# Cloudflare Worker relay

A standalone edge relay. Usually on its own origin (`*.workers.dev`), so CORS
headers are included. Key lives in a Worker secret.

```js
// worker.js
const CORS = {
  "access-control-allow-origin": "https://your-app.example", // your app origin
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const upstream = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: req.body, // forwarded unchanged; SSE streams back as-is
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, "content-type": upstream.headers.get("content-type") ?? "text/event-stream" },
    });
  },
};
```

Setup (needs Wrangler — `npm install -D wrangler` or use `npx wrangler`, and
`wrangler login` once):

```bash
wrangler secret put LLM_API_KEY
wrangler secret put LLM_BASE_URL   # e.g. https://api.openai.com/v1
wrangler deploy
```

Client:

```ts
import { Ludion } from "ludion-router";

const ludion = await Ludion.create({
  fallback: { url: "https://your-relay.workers.dev", model: "gpt-4o-mini" },
});
```
