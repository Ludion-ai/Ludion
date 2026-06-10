import type {
  BenchAdapter,
  DownloadProgress,
  GenRequest,
  GenResult,
  LoadInfo,
  TokenEvent,
} from "./types";
import type { EngineModelRef } from "../models";
// Official distribution asset, served from our own origin (no vendoring/patching).
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";

/**
 * wllama adapter. Notes from spec review:
 *  - v3.1+ ships WebGPU in the official npm package, enabled by default on
 *    Chromium; on Safari it runs on WASM. The backend field records which.
 *  - Decision (a): no COOP/COEP headers, so no crossOriginIsolation =>
 *    single-threaded WASM. Labeled via isMultithread() after load, not assumed.
 *  - cache_prompt is forced to false: llama-server's prompt KV cache would
 *    otherwise make timed runs 2..3 skip prefill entirely and corrupt
 *    prefill_tps for identical repeated prompts.
 *  - Safari 26 compat: wllama auto-applies @wllama/wllama-compat (official
 *    package, CDN-served) — documented engine behavior, not a patch.
 */
export function createWllamaAdapter(): BenchAdapter {
  // Note: the package's `main` points at a non-existent index.js and falls back
  // to raw TS sources; import the official prebuilt ESM dist explicitly.
  let wllama: import("@wllama/wllama/esm/index.js").Wllama | null = null;

  return {
    id: "wllama",
    version: () => __ENGINE_VERSIONS__.wllama,

    async load(model: EngineModelRef, onProgress: (p: DownloadProgress) => void): Promise<LoadInfo> {
      const { Wllama } = await import("@wllama/wllama/esm/index.js");
      wllama = new Wllama({ default: wllamaWasmUrl });
      if (!model.file) throw new Error("wllama: ModelSpec.file (GGUF path) is required");

      let downloadDone = false;
      await wllama.loadModelFromHF(
        { repo: model.modelId, file: model.file },
        {
          n_ctx: 4096,
          progressCallback: ({ loaded, total }) => {
            downloadDone = total > 0 && loaded >= total;
            onProgress({
              kind: downloadDone ? "init" : "download",
              loadedBytes: loaded,
              totalBytes: total,
              approxMb: null,
              text: `fetch ${Math.round(loaded / 1e6)}/${Math.round(total / 1e6)}MB`,
            });
          },
        },
      );

      const backend = wllama.isSupportWebGPU()
        ? "webgpu"
        : wllama.isMultithread()
          ? "wasm-multithread"
          : "wasm-singlethread";
      return { backend, timingSource: "engine" };
    },

    async generate(req: GenRequest, onToken: (t: TokenEvent) => void): Promise<GenResult> {
      if (!wllama) throw new Error("wllama: generate() before load()");
      const chunks = await wllama.createChatCompletion({
        messages: [{ role: "user", content: req.prompt }],
        stream: true,
        temperature: 0,
        max_tokens: req.maxTokens,
        cache_prompt: false,
      });

      let text = "";
      let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
      let timings: { prompt_per_second: number; predicted_per_second: number } | null = null;
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken({ textDelta: delta });
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.timings) timings = chunk.timings;
      }

      return {
        text,
        tokensIn: usage?.prompt_tokens ?? null,
        tokensOut: usage?.completion_tokens ?? null,
        tokenCountSource: "engine",
        engineReported:
          timings || usage
            ? {
                ...(timings ? { prefillTps: timings.prompt_per_second, decodeTps: timings.predicted_per_second } : {}),
                ...(usage
                  ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
                  : {}),
              }
            : undefined,
      };
    },

    async unload(): Promise<void> {
      if (wllama) {
        await wllama.exit();
        wllama = null;
      }
    },
  };
}
