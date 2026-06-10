import type {
  BenchAdapter,
  DownloadProgress,
  GenRequest,
  GenResult,
  LoadInfo,
  TokenEvent,
} from "./types";
import type { EngineModelRef } from "../models";
import type { Backend } from "../schema";

/**
 * Transformers.js adapter. Notes from spec review:
 *  - Engine version pinned at 4.2.0; v4 replaced the v3-era runtime, and its
 *    WebGPU behavior on iOS Safari is unverified => the backend actually used
 *    is recorded per run (3-value enum).
 *  - WebGPU is attempted first when navigator.gpu exists; if model load fails
 *    there, the adapter retries on WASM. The fallback is loud (progress event)
 *    and visible in the backend field — not a silent re-measure.
 *  - Without COOP/COEP (decision: case (a)) there is no crossOriginIsolation,
 *    so the WASM path is single-threaded; labeled via crossOriginIsolated.
 */
export function createTransformersJsAdapter(): BenchAdapter {
  let pipe: import("@huggingface/transformers").TextGenerationPipeline | null = null;
  let backend: Backend = "wasm-singlethread";

  return {
    id: "transformersjs",
    version: () => __ENGINE_VERSIONS__.transformersjs,

    async load(model: EngineModelRef, onProgress: (p: DownloadProgress) => void): Promise<LoadInfo> {
      const { pipeline } = await import("@huggingface/transformers");

      const progressCallback = (info: { status: string; loaded?: number; total?: number; file?: string }) => {
        onProgress({
          kind: info.status === "progress" || info.status === "download" || info.status === "initiate" ? "download" : "init",
          loadedBytes: typeof info.loaded === "number" ? info.loaded : null,
          totalBytes: typeof info.total === "number" ? info.total : null,
          approxMb: null,
          text: `${info.status}${info.file ? ` ${info.file}` : ""}`,
        });
      };

      const wasmBackend: Backend =
        typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
          ? "wasm-multithread"
          : "wasm-singlethread";
      const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu;

      const create = (device: "webgpu" | "wasm") =>
        pipeline("text-generation", model.modelId, {
          device,
          dtype: (model.dtype ?? "q4f16") as import("@huggingface/transformers").DataType,
          progress_callback: progressCallback as never,
        });

      if (hasWebGpu) {
        try {
          pipe = await create("webgpu");
          backend = "webgpu";
          return { backend, timingSource: "engine" };
        } catch (e) {
          onProgress({
            kind: "init",
            loadedBytes: null,
            totalBytes: null,
            approxMb: null,
            text: `webgpu load failed (${e instanceof Error ? e.message : String(e)}); retrying on wasm — backend field will record the fallback`,
          });
        }
      }
      pipe = await create("wasm");
      backend = wasmBackend;
      return { backend, timingSource: "engine" };
    },

    async generate(req: GenRequest, onToken: (t: TokenEvent) => void): Promise<GenResult> {
      if (!pipe) throw new Error("transformersjs: generate() before load()");
      const { TextStreamer } = await import("@huggingface/transformers");

      const messages = [{ role: "user", content: req.prompt }];

      // Engine-tokenizer count of the templated prompt (token_count_source: "engine").
      let tokensIn: number | null = null;
      try {
        const ids = pipe.tokenizer.apply_chat_template(messages, {
          add_generation_prompt: true,
          tokenize: true,
          return_tensor: false,
        }) as unknown as number[];
        tokensIn = Array.isArray(ids) ? ids.length : null;
      } catch {
        tokensIn = null;
      }

      let tokensOut = 0;
      let text = "";
      const streamer = new TextStreamer(pipe.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (piece: string) => {
          if (piece) {
            text += piece;
            onToken({ textDelta: piece });
          }
        },
        token_callback_function: (tokens: bigint[]) => {
          tokensOut += tokens.length;
        },
      });

      const output = (await pipe(messages, {
        max_new_tokens: req.maxTokens,
        do_sample: false,
        return_full_text: false,
        streamer,
      } as never)) as Array<{ generated_text: string | Array<{ role: string; content: string }> }>;

      // Prefer the pipeline's own final text when available.
      const generated = output[0]?.generated_text;
      if (typeof generated === "string") {
        text = generated;
      } else if (Array.isArray(generated)) {
        const last = generated.at(-1);
        if (last && typeof last.content === "string") text = last.content;
      }

      return {
        text,
        tokensIn,
        tokensOut: tokensOut > 0 ? tokensOut : null,
        tokenCountSource: "engine",
      };
    },

    async unload(): Promise<void> {
      if (pipe) {
        await pipe.dispose();
        pipe = null;
      }
    },
  };
}
