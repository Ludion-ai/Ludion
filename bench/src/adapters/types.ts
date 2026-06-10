import type { Backend, EngineId, MetricSource } from "../schema";
import type { EngineModelRef } from "../models";

/**
 * Engine adapter contract (spec Section 7).
 * Adapters contain ONLY engine-API glue. All timing instrumentation lives in
 * the shared harness (harness.ts) so every engine is measured by the same
 * clock and code path. Adapters surface engine events; the harness timestamps
 * them.
 */

export interface DownloadProgress {
  /** Phase classification, where the engine lets us distinguish. */
  kind: "download" | "init";
  loadedBytes: number | null;
  totalBytes: number | null;
  /**
   * WebLLM only: MB parsed from progress text ("... 869MB fetched ..."),
   * because its callback does not expose byte counts. Estimated, not exact.
   */
  approxMb: number | null;
  text: string;
}

export interface LoadInfo {
  /** Execution path actually in use after load (3-value enum, spec amendment). */
  backend: Backend;
  /** Whether the download/init phase split came from engine events or parsing. */
  timingSource: MetricSource;
  /**
   * KV-cache sizing actually in effect — a measurement condition, recorded per
   * run (kv_context_window / prefill_chunk). WebLLM preallocates the KV cache
   * at the full context window on load, so this drives baseline memory.
   * null where the engine does not expose / we do not control the value.
   */
  kvContextWindow: number | null;
  prefillChunk: number | null;
}

export interface TokenEvent {
  /** Cumulative generated text length is enough; the harness only timestamps. */
  textDelta: string;
}

export interface GenResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource: MetricSource;
  /**
   * Engine-reported throughput where the engine measures it itself
   * (WebLLM usage.extra, wllama timings). Recorded alongside the harness's
   * own clock-based numbers; harness numbers win for cross-engine
   * comparability, engine numbers are kept in the live log for sanity checks.
   */
  engineReported?: {
    prefillTps?: number;
    decodeTps?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface GenRequest {
  prompt: string;
  maxTokens: number;
}

export interface BenchAdapter {
  id: EngineId;
  version(): string;
  /** Resolves at "ready to accept a prompt". */
  load(model: EngineModelRef, onProgress: (p: DownloadProgress) => void): Promise<LoadInfo>;
  generate(req: GenRequest, onToken: (t: TokenEvent) => void): Promise<GenResult>;
  /** Best-effort teardown. The harness reloads the page between engines regardless. */
  unload(): Promise<void>;
}

declare global {
  // Injected by vite.config.ts / vitest.config.ts from package.json pins.
  const __ENGINE_VERSIONS__: Record<EngineId, string>;
}
