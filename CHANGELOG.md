# Changelog

## 0.1.3 — 2026-06-15

Additive groundwork for the client-side savings engine (Gate 6-A). No routing,
timing, or existing-field behavior changed; behavior is byte-identical to 0.1.2
for every existing consumer.

- `DecisionLog` gains `tokens_source: "exact" | "estimated"`. `"exact"` means the
  engine/server reported a usage object (so `tokens_in`/`tokens_out` are real
  token counts); `"estimated"` means no usage was reported, so `tokens_out` is a
  content-chunk count and `tokens_in` is `null`. This makes token-count provenance
  explicit instead of relying on the implicit "`tokens_in !== null`" heuristic —
  required so downstream savings figures can flag estimated entries.
- New `ludion-router/savings` subpath export: a standalone, opt-in client-side
  savings ledger + computation (counts/metadata only, never prompt/response
  content; localStorage, bounded). The router core writes no storage unless an
  integrator explicitly wires `new SavingsLedger()` to `onDecision`.

> Note: there is no `0.1.2` entry above — `0.1.2` (WebLLM context cap / KV sizing)
> was released without a changelog entry. Left as-is rather than retro-documented.

## 0.1.1 — 2026-06-12

Time-to-first-wow release: zero-config local-only mode, plus the correct
(proxy-based) shape for the server fallback.

- `fallback` is now optional. `Ludion.create()` works with zero arguments:
  local-routed requests run on-device exactly as before; requests the policy
  routes (or degrades) to the server throw the new typed
  `LudionNoFallbackConfigured` (carries the deciding `rule_id`) instead of
  fetching nowhere. With a `fallback` configured, behavior is byte-identical
  to 0.1.0. Exactly one error class was added; the rest of the public API is
  unchanged.
- Added `LudionOptions.onLocalLoadProgress` — optional passthrough of the
  local engine's download/init progress (Gate 2.5 F-2). Additive; absent =
  identical behavior to 0.1.0.
- Docs: README quickstart now leads with the zero-config form; the fallback
  example uses a relay proxy (key in server-side env, never in client code),
  with copyable ~15-line relays in `docs/recipes/` (Next.js route handler /
  Cloudflare Worker / Express) and a clone-and-run template in
  `examples/next-starter/`.

## 0.1.0 — 2026-06-11

First public release of `ludion-router` (npm name; the project is Ludion —
`ludion` is blocked by npm's typosquat protection against `luxon`), a
per-request router between on-device
WebGPU inference (WebLLM, dynamically loaded) and a bring-your-own
OpenAI-compatible server endpoint.

What it actually is: a deterministic, versioned policy table (`v0-20260610`,
rules R1–R6) derived from the archived benchmark runs in `bench/results/`
(counts and medians in the generated tables of the README and
`docs/report/`), a strike/tombstone system that learns
from crashes, a privacy mode that never sends to server, and a per-request
decision log. Honest scope: WebLLM is the only local engine, the fallback
endpoint must allow browser CORS, parts of the policy are 2-point
interpolations, and nothing here is production-hardened yet.
