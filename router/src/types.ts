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
  error: string | null;
}

export interface LudionOptions {
  fallback: FallbackConfig;
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
