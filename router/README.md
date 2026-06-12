# ludion-router

**A load balancer between your users' GPUs and your cloud.** Per-request
routing of AI inference: probe → deterministic policy → local (WebLLM/WebGPU)
or your own OpenAI-compatible server → structured decision log.

This is the npm package (`ludion-router` — the project is **Ludion**; the
registry name differs only because `ludion` is blocked by npm's typosquat
protection against `luxon`). The repository — including the benchmark harness
and the measurement report the policy is derived from — lives at
[Ludion-ai/Ludion](https://github.com/Ludion-ai/Ludion).

```bash
npm install ludion-router
```

Zero config — local-only mode (server-routed requests throw the typed
`LudionNoFallbackConfigured`):

```ts
const ludion = await Ludion.create();
const stream = await ludion.chat.completions.create({ messages, stream: true });
for await (const chunk of stream) { /* ran on the user's GPU */ }
```

With a fallback (point it at your own ~15-line relay proxy so the API key
stays server-side — recipes in the repo's `docs/recipes/`):

```ts
import { Ludion } from "ludion-router";

const ludion = await Ludion.create({
  fallback: { url: "/api/chat", model }, // your relay → your provider (key in server env)
  localModel: "Llama-3.2-1B-Instruct-q4f16_1-MLC", // default
  onDecision: (log) => console.log(log),
  hints: { privacy: false },
});

const stream = await ludion.chat.completions.create({
  messages, max_tokens: 256, stream: true,
});
for await (const chunk of stream) { /* OpenAI-style chunks, both targets */ }
stream._ludion; // DecisionLog (non-enumerable), mutated with ttft/tps on completion
```

## Public API

`Ludion` (entry point), `LudionPrivacyUnroutable` / `LudionMidStreamError` /
`LudionNoFallbackConfigured` (errors), and the types `DecisionLog`,
`PolicyTable`, `ModelId` plus the
option/response types their signatures require. Everything else (policy
evaluator, strike store, executors) is internal and not exported.

## Fallback endpoint: browser CORS is REQUIRED

The browser calls the configured `/chat/completions` URL directly with
`fetch`. Host a small relay on your own backend (Next.js route handler /
Cloudflare Worker / Express — copy one from the repo's `docs/recipes/`): the
provider key stays in your server's environment, and a same-origin relay
sidesteps CORS entirely. If you point `fallback.url` at a cross-origin
endpoint instead, it **must** allow requests from the app origin:
`Access-Control-Allow-Origin`, plus the `authorization` and `content-type`
request headers (preflight). A key that works from curl but not from the
page is almost always CORS.

## Policy v0 (data, not code)

`policy.v0.json` (inlined into the bundle), version `v0-20260610`, ordered
rules, first match wins, every decision logs `{policy_version, rule_id}`.
Derived from the archived measurements in the repo's `bench/results/`.
R1 IAB→server, R2 no-WebGPU→server, R3 all-iOS→server, R4 desktop→local
(≤3000 est tok), R5 Android→local (≤200 est tok, ≤256 max_tokens, stream
only), R6 default→server. Full evidence table: see the
[repository README](https://github.com/Ludion-ai/Ludion#readme).

- `privacy: true` never sends to server: forces local where the hardware
  class allows it (`R5+privacy`), otherwise throws `LudionPrivacyUnroutable`.
- Token estimate: `ceil(cjk × 1.0 + other / 4)` — error bars: English
  +20–35% over (safe), Japanese ±15%, mixed code −10…+30%. Bias is always
  toward server, by design.

## Degrade & strikes

- `stream:false` → any local failure transparently retries on server.
- `stream:true` → transparent retry only **before** the first yielded token;
  after that the stream ends with `LudionMidStreamError`
  (`degraded_failed` in the log). Server-side continuation is forbidden.
- Tombstone (localStorage, `ludion.router.*`): a tab kill during
  load/generate = +1.0 strike on next boot; a caught failure = +0.5; score
  ≥ 1 short-circuits that model to server for 7 days (TTL configurable).
  Context-window-overflow errors degrade without striking.

## Local engine

WebLLM 0.2.84 (pinned), dynamically imported only after a local decision —
server-routed sessions never download engine code or weights (verified
against the built dist on every publish). KV context window defaults to
4096 (`localContextWindow`), recorded per decision. The first local request
downloads the model; `onLocalLoadProgress` exposes the engine's progress so
the UI never stalls silently. Cancellation: consumer
`break` → `interruptGenerate()` locally, `AbortController.abort()` for
server SSE.

## License

MIT
