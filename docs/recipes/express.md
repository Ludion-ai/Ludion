# Express relay

For an existing Node backend (Node ≥ 18 for global `fetch`). CORS headers
included for the cross-origin case; if the app is served from the same
origin, you can drop them.

```js
// relay.mjs
import { Readable } from "node:stream";
import express from "express";

const CORS = {
  "access-control-allow-origin": "https://your-app.example", // your app origin
  "access-control-allow-headers": "authorization, content-type",
};

const app = express();
app.use(express.text({ type: "application/json" })); // keep raw body

app.options("/api/chat", (_req, res) => res.set(CORS).sendStatus(204));
app.post("/api/chat", async (req, res) => {
  const upstream = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: req.body, // forwarded unchanged
  });
  res.status(upstream.status).set({
    ...CORS,
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
  });
  Readable.fromWeb(upstream.body).pipe(res); // SSE streams back as-is
});

app.listen(8787);
```

Run:

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... node relay.mjs
```

Client:

```ts
const ludion = await Ludion.create({
  fallback: { url: "http://localhost:8787/api/chat", model: "gpt-4o-mini" },
});
```
