# Relay proxy recipes

`ludion-router` calls the `fallback.url` directly from the browser. The
correct shape is a ~15-line relay **you** host: the browser talks to your
relay, the relay talks to your LLM provider, and the provider API key lives
only in your server's environment — never in client code.

Pick one:

- [Next.js route handler](nextjs-route-handler.md) — same-origin `/api/chat`,
  no CORS needed at all
- [Cloudflare Worker](cloudflare-worker.md) — standalone edge relay
- [Express](express.md) — for an existing Node backend

All three:

1. forward the OpenAI-shaped request body to
   `${LLM_BASE_URL}/chat/completions` unchanged (any OpenAI-compatible
   provider works),
2. attach `Authorization: Bearer ${LLM_API_KEY}` from server-side env,
3. stream the SSE response straight back (no buffering),
4. answer CORS preflight where the relay is on a different origin than the
   app.

Then:

```ts
const ludion = await Ludion.create({
  fallback: { url: "/api/chat", model: "your-server-model" },
});
```

A clone-and-run template with the Next.js relay already wired up lives at
[`examples/next-starter/`](../../examples/next-starter/).
