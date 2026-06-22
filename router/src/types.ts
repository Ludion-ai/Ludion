import type { ChatMessage, RouterProbe } from "@ludion/shared";
import type { PolicyTable } from "./policy";
import type { KV } from "./strikes";

/** WebLLM prebuilt model identifier (e.g. "Llama-3.2-1B-Instruct-q4f16_1-MLC"). */
export type ModelId = string;

/** Normalized generation request handed to either executor. */
export interface GenRequest {
  messages: ChatMessage[];
  /** Always materialized (request value ?? policy default). */
  max_tokens: number;
  temperature?: number;
}

export interface FallbackConfig {
  /**
   * Full URL of the customer-supplied OpenAI-compatible `/chat/completions`
   * endpoint (no proxy — the browser calls it directly).
   *
   * CORS (A-5): because the call is made from the browser, the endpoint MUST
   * allow cross-origin requests from the app origin (Access-Control-Allow-
   * Origin + the `authorization` / `content-type` headers). Without it every
   * server-routed request fails in a way local testing with curl won't show.
   */
  url: string;
  apiKey?: string;
  model: string;
}

/**
 * Structured per-request decision log (spec Section 1.5, decisions A-6).
 * Decision-time fields are set when the route is chosen; measurement fields
 * are appended by MUTATING this same object when the request completes (or
 * fails / is cancelled), so a reference captured at decision time converges
 * to the full record. `onDecision` fires exactly once, at terminal state.
 */
export interface DecisionLog {
  /** Schema version of the derived DecisionEvent (telemetry.ts). */
  schema_version: string;
  /** Unique per-decision id (uuid). Random — NEVER derived from prompt content. */
  decision_id: string;
  policy_version: string;
  rule_id: string;
  /** "unroutable" = privacy:true with no local path (LudionPrivacyUnroutable thrown). */
  target: "local" | "server" | "unroutable";
  /** Model the request executes on; rewritten to the fallback model on degrade. */
  model: ModelId;
  privacy: boolean;
  stream: boolean;
  est_prompt_tokens: number;
  max_tokens: number;
  /** Local KV context window in effect (B-4; default 4096). */
  local_context_window: number;
  /**
   * On-device engine state for this request:
   *   "cold"    = the WebLLM engine was (re)created this request,
   *   "warm"    = an already-loaded engine was reused,
   *   "unknown" = no on-device load was attempted (server route, or failed
   *               before the load reported a state).
   */
  cache_state: "cold" | "warm" | "unknown";
  /**
   * Wall time (ms) of a COLD on-device model load; null when warm or when no
   * load happened. A total only — WebLLM 0.2.84 does not expose a clean
   * download/compile split or a byte count, so those are deliberately omitted.
   *
   * CAVEAT — UNLABELED BIMODAL MIXTURE: the cold bucket conflates a first-time
   * download+compile with a disk-cached recompile (the OPFS/Cache weight cache
   * is a separate axis from cache_state, which tracks only in-memory engine
   * reuse). No field labels which mode a given sample is, so this is NOT
   * recoverable by stratifying on cache_state or device_class. Treat it as a
   * mixture: never present as a bare mean; p50/p90/distribution only (use
   * summarizeLoadTotalMs from @ludion/shared). The local ledger deliberately
   * drops this field so the on-device dashboard cannot present it at all.
   *
   * TODO(weights_cached): the proper fix is a `weights_cached` boolean probed
   * from OPFS/Cache-API before the load, to label download-vs-cached and split
   * the mixture. Deferred — WebLLM 0.2.84 does not expose disk-cache hits
   * cleanly.
   */
  load_total_ms: number | null;
  strike_state: Record<ModelId, number>;
  probe: RouterProbe;
  decided_at: string;
  // --- appended at terminal state (mutated; A-6) ---
  completed: boolean;
  /** Transparent local→server retry happened (pre-first-token or non-stream). */
  degraded: "local→server" | null;
  /** Local stream failed AFTER first token: not retryable, stream errored (A-2). */
  degraded_failed: boolean;
  cancelled: boolean;
  /** ms from generation start (post model-load) to first content token (D-3). */
  ttft_ms: number | null;
  /** (n-1)/Δt over content chunks, bench-compatible definition (D-3). */
  tps: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /**
   * Provenance of tokens_in/tokens_out. "exact" = engine/server reported a
   * usage object; "estimated" = no usage reported, so tokens_out is a content-
   * chunk count and tokens_in is null (consumers backfill from
   * est_prompt_tokens). Additive marker so savings figures never rest on the
   * implicit "tokens_in !== null" heuristic.
   */
  tokens_source: "exact" | "estimated";
  error: string | null;
}

export interface LudionOptions {
  /**
   * Optional since 0.1.1 (Phase 0). Absent = local-only mode: any request
   * the policy routes (or degrades) to the server throws
   * `LudionNoFallbackConfigured` instead. Existing configured behavior is
   * unchanged.
   */
  fallback?: FallbackConfig;
  /** Default: "Llama-3.2-1B-Instruct-q4f16_1-MLC". */
  localModel?: ModelId;
  /** Default: bundled policy.v0.json. */
  policy?: PolicyTable;
  onDecision?: (log: DecisionLog) => void;
  /** privacy:true forbids the server target for all requests (per-request hint overrides). */
  hints?: { privacy?: boolean };
  /** Local WebLLM KV context window. Default 4096 (B-4). */
  localContextWindow?: number;
  /**
   * Progress of the local model download/initialization (WebLLM
   * initProgressCallback passthrough). Fires only on local-routed requests
   * that trigger a load — never on server routes. Additive, optional
   * (Gate 2.5 F-2): absent = identical behavior to 0.1.0.
   */
  onLocalLoadProgress?: (p: { progress: number; text: string }) => void;
  /** Strike TTL in ms. Default 7 days. */
  strikeTtlMs?: number;
  /** Internal test hooks — not public API. */
  _test?: {
    probe?: RouterProbe;
    kv?: KV;
    now?: () => number;
    localExecutor?: import("./local").LocalExecutor;
    serverExecutor?: import("./server").ServerExecutor;
  };
}

/** OpenAI-shaped request with optional per-request Ludion hints. */
export interface LudionChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  ludion?: { privacy?: boolean };
}
