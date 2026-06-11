# Changelog

## 0.1.0 — 2026-06-11

First public release of `ludion`, a per-request router between on-device
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
