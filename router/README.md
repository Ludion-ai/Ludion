# entelic-router

Gate 1 thin router: probe → deterministic policy → local (WebLLM) or
customer server fallback → structured decision log. See
`entelic-gate1-spec.md` + `entelic-gate1-decisions.md` (the binding contract).

```ts
import { Entelic } from "entelic-router";

const entelic = await Entelic.create({
  fallback: { url, apiKey, model },     // OpenAI-compatible /chat/completions
  localModel: "Llama-3.2-1B-Instruct-q4f16_1-MLC", // default
  onDecision: (log) => console.log(log),
  hints: { privacy: false },
});

const stream = await entelic.chat.completions.create({
  messages, max_tokens: 256, stream: true,
});
for await (const chunk of stream) { /* OpenAI-style chunks, both targets */ }
stream._entelic; // DecisionLog (non-enumerable), mutated with ttft/tps on completion
```

## Fallback endpoint: browser CORS is REQUIRED

There is no proxy. The browser calls the customer-supplied
`/chat/completions` URL directly with `fetch`. The endpoint **must** allow
cross-origin requests from the app origin: `Access-Control-Allow-Origin`,
plus the `authorization` and `content-type` request headers (preflight).
A key that works from curl but not from the page is almost always CORS.

## Policy v0 (data, not code)

`src/policy.v0.json`, version `v0-20260610`, ordered rules, first match wins,
every decision logs `{policy_version, rule_id}`. Derived from
`bench/results/supplier-table.md` (Gate 0). R1 IAB→server, R2 no-WebGPU→server,
R3 all-iOS→server, R4 desktop→local (≤3000 est tok), R5 Android→local
(≤200 est tok, ≤256 max_tokens, stream only), R6 default→server.

- `privacy: true` never sends to server: forces local where the hardware
  class allows it (`R5+privacy`), otherwise throws `EntelicPrivacyUnroutable`.
- Token estimate: `ceil(cjk × 1.0 + other / 4)` — error bars: English
  +20–35% over (safe), Japanese ±15%, mixed code −10…+30%. Bias is always
  toward server, by design.

## Degrade & strikes

- `stream:false` → any local failure transparently retries on server.
- `stream:true` → transparent retry only **before** the first yielded token;
  after that the stream ends with `EntelicMidStreamError`
  (`degraded_failed` in the log). Server-side continuation is forbidden.
- Tombstone (localStorage, `entelic.router.*`, bench-independent): a tab
  kill during load/generate = +1.0 strike on next boot; a caught failure
  = +0.5; score ≥ 1 short-circuits that model to server for 7 days (TTL
  configurable). Context-window-overflow errors degrade without striking.

## Local engine

WebLLM 0.2.84 (pinned), dynamically imported only after a local decision —
server-routed sessions never download engine code or weights. KV context
window defaults to 4096 (`localContextWindow`), recorded per decision.
Cancellation: consumer `break` → `interruptGenerate()` locally,
`AbortController.abort()` for server SSE.
