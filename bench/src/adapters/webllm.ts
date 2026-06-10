import type {
  BenchAdapter,
  DownloadProgress,
  GenRequest,
  GenResult,
  LoadInfo,
  TokenEvent,
} from "./types";
import type { EngineModelRef } from "../models";

/**
 * WebLLM adapter. Notes from spec review:
 *  - reload() conflates fetch + shader compile; the download/init split is
 *    parsed from progress text => timing_source: "estimated".
 *  - Progress text exposes "<n>MB fetched" — recorded as approxMb (estimated).
 *  - WebLLM is WebGPU-only; if navigator.gpu is absent, load() rejects and the
 *    harness records an init-stage error row (that is data, not a crash).
 *  - unload() is known-unreliable for re-init in the same session (issues
 *    #517/#647); the harness's reload-between-engines flow makes this moot.
 */
/**
 * KV-cache cap (hypothesis test, 2026-06-10): WebLLM preallocates the paged KV
 * cache at the full context window on load (create_tir_paged_kv_cache with
 * max_total_sequence_length = context_window_size). The prebuilt records for
 * all three models override context_window_size to 4096; on a 4 GB iPhone the
 * weights + 4096-token KV converge at a similar total for 0.5B and 1B models,
 * matching the observed identical tab kills. 2048 halves the prealloc while
 * still fitting the longest bench prompt (~1350 tok) + max_tokens 128.
 * chatOpts wins the config merge: { ...config.json, ...record.overrides, ...chatOpts }.
 */
export const KV_CONTEXT_WINDOW = 2048;

/**
 * NOT overridable in web-llm 0.2.84: prefill_chunk_size is absent from
 * ChatConfig/ChatOptions and is read from the compiled model lib's wasm
 * metadata. All three pinned models use "_cs1k" libs => chunk size 1024,
 * recorded here as the effective measurement condition.
 */
const PREFILL_CHUNK_EFFECTIVE = 1024;

export function createWebLLMAdapter(): BenchAdapter {
  // Loaded lazily so merely importing the adapter never touches WebGPU.
  let engine: import("@mlc-ai/web-llm").MLCEngine | null = null;

  return {
    id: "webllm",
    version: () => __ENGINE_VERSIONS__.webllm,

    async load(model: EngineModelRef, onProgress: (p: DownloadProgress) => void): Promise<LoadInfo> {
      if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
        throw new Error("WebGPU not available (navigator.gpu missing); WebLLM has no fallback");
      }
      const webllm = await import("@mlc-ai/web-llm");
      engine = await webllm.CreateMLCEngine(
        model.modelId,
        {
          initProgressCallback: (report) => {
            const fetching = /fetch/i.test(report.text) || /download/i.test(report.text);
            const mbMatch = /([\d.]+)\s*MB/i.exec(report.text);
            onProgress({
              kind: fetching ? "download" : "init",
              loadedBytes: null,
              totalBytes: null,
              approxMb: mbMatch ? Number(mbMatch[1]) : null,
              text: report.text,
            });
          },
        },
        { context_window_size: KV_CONTEXT_WINDOW },
      );
      return {
        backend: "webgpu",
        timingSource: "estimated",
        kvContextWindow: KV_CONTEXT_WINDOW,
        prefillChunk: PREFILL_CHUNK_EFFECTIVE,
      };
    },

    async generate(req: GenRequest, onToken: (t: TokenEvent) => void): Promise<GenResult> {
      if (!engine) throw new Error("webllm: generate() before load()");
      const chunks = await engine.chat.completions.create({
        messages: [{ role: "user", content: req.prompt }],
        temperature: 0,
        max_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      });
      let text = "";
      let usage: import("@mlc-ai/web-llm").CompletionUsage | undefined;
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken({ textDelta: delta });
        }
        if (chunk.usage) usage = chunk.usage;
      }
      return {
        text,
        tokensIn: usage?.prompt_tokens ?? null,
        tokensOut: usage?.completion_tokens ?? null,
        tokenCountSource: "engine",
        engineReported: usage
          ? {
              prefillTps: usage.extra.prefill_tokens_per_s,
              decodeTps: usage.extra.decode_tokens_per_s,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
            }
          : undefined,
      };
    },

    async unload(): Promise<void> {
      if (engine) {
        await engine.unload();
        engine = null;
      }
    },
  };
}
