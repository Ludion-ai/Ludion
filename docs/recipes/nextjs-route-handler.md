# Next.js route handler relay

`app/api/chat/route.ts` — same origin as your app, so the browser needs no
CORS at all. Key stays in `.env.local` / your deployment's env.

```ts
// app/api/chat/route.ts
export async function POST(req: Request): Promise<Response> {
  const upstream = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: await req.text(), // forwarded unchanged; SSE streams back as-is
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    },
  });
}
```

Env (server-side only — no `NEXT_PUBLIC_` prefix, ever):

```bash
# .env.local
LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible provider
LLM_API_KEY=sk-...
```

Client:

```ts
const ludion = await Ludion.create({
  fallback: { url: "/api/chat", model: "gpt-4o-mini" },
});
```

If the relay is deployed on a *different* origin than the page, add the CORS
headers shown in the [Cloudflare Worker recipe](cloudflare-worker.md) and an
`OPTIONS` export returning them.
