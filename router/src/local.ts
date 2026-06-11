import type { ChatCompletion, ChatCompletionChunk } from "@ludion/shared";
import type { GenRequest } from "./types";

/**
 * Local WebLLM executor.
 *
 * INTENTIONAL DUPLICATION (Gate 1 decisions Q1/A-1): this is NOT extracted
 * from `bench/src/adapters/webllm.ts` — the bench adapter is an
 * instrumentation wrapper for measurement and stays untouched so Gate 0
 * numbers remain comparable. WebLLM 0.2.84 natively returns an OpenAI-style
 * chunk AsyncIterable from `engine.chat.completions.create({stream:true})`
 * ([VERIFY-1]), so no normalization layer is needed on the local side.
 *
 * Lazy loading (Q2): `@mlc-ai/web-llm` is dynamically imported ONLY inside
 * `ensureLoaded()`, i.e. only after the policy decided "local". Bundlers
 * split it into its own chunk, so server-routed sessions never fetch engine
 * code, let alone model weights. The probe needs only `navigator.gpu`.
 *
 * Cancellation ([VERIFY-2]): WebLLM 0.2.84 has no AbortSignal on chat
 * completions; `engine.interruptGenerate()` is the interruption mechanism.
 */
export interface LocalExecutor {
  ensureLoaded(modelId: string, contextWindow: number): Promise<void>;
  stream(req: GenRequest): Promise<AsyncIterable<ChatCompletionChunk>>;
  complete(req: GenRequest): Promise<ChatCompletion>;
  interrupt(): Promise<void>;
}

export function createWebLLMExecutor(): LocalExecutor {
  let engine: import("@mlc-ai/web-llm").MLCEngine | null = null;
  let loadedModelId: string | null = null;

  return {
    async ensureLoaded(modelId: string, contextWindow: number): Promise<void> {
      if (engine && loadedModelId === modelId) return;
      if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
        throw new Error("WebGPU not available (navigator.gpu missing); WebLLM has no fallback");
      }
      const webllm = await import("@mlc-ai/web-llm");
      engine = await webllm.CreateMLCEngine(modelId, {}, { context_window_size: contextWindow });
      loadedModelId = modelId;
    },

    async stream(req: GenRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      if (!engine) throw new Error("ludion-router: local stream() before ensureLoaded()");
      const chunks = await engine.chat.completions.create({
        messages: req.messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        stream: true,
        stream_options: { include_usage: true },
      });
      // WebLLM chunks are structurally OpenAI chunks ([VERIFY-1]).
      return chunks as AsyncIterable<ChatCompletionChunk>;
    },

    async complete(req: GenRequest): Promise<ChatCompletion> {
      if (!engine) throw new Error("ludion-router: local complete() before ensureLoaded()");
      const completion = await engine.chat.completions.create({
        messages: req.messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        stream: false,
      });
      return completion as ChatCompletion;
    },

    async interrupt(): Promise<void> {
      await engine?.interruptGenerate();
    },
  };
}
