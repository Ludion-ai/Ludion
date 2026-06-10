import type { EngineId } from "./schema";

/**
 * Model triples approved at spec review (2026-06-10).
 * Primary: Qwen2.5-1.5B-Instruct — same checkpoint published in all three formats.
 * Secondary: Llama-3.2-1B-Instruct — smaller, safer on iPhone memory ceilings.
 *
 * Operator protocol: desktop starts with Qwen; iPhone runs Llama first, then
 * attempts Qwen. An OOM tab kill on Qwen is a routing-table row, not a failure
 * (recorded via the tombstone marker, see state.ts).
 */

export type ModelKey = "qwen2.5-1.5b" | "llama-3.2-1b";

export interface EngineModelRef {
  /** Identifier passed to the engine (and recorded as model_id). */
  modelId: string;
  quant: string;
  /** wllama only: GGUF file within the HF repo. */
  file?: string;
  /** transformersjs only: dtype passed to pipeline(). */
  dtype?: string;
  /** Approximate artifact size, shown to the operator before download. */
  approxMb: number;
}

export interface ModelSpec {
  key: ModelKey;
  label: string;
  engines: Record<EngineId, EngineModelRef>;
}

export const MODELS: readonly ModelSpec[] = [
  {
    key: "qwen2.5-1.5b",
    label: "Qwen2.5-1.5B-Instruct (primary)",
    engines: {
      webllm: {
        modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
        quant: "q4f16_1",
        approxMb: 869,
      },
      transformersjs: {
        modelId: "onnx-community/Qwen2.5-1.5B-Instruct",
        quant: "q4f16",
        dtype: "q4f16",
        approxMb: 1222,
      },
      wllama: {
        modelId: "bartowski/Qwen2.5-1.5B-Instruct-GGUF",
        file: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        quant: "Q4_K_M",
        approxMb: 986,
      },
    },
  },
  {
    key: "llama-3.2-1b",
    label: "Llama-3.2-1B-Instruct (secondary, iPhone-first)",
    engines: {
      webllm: {
        modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        quant: "q4f16_1",
        approxMb: 695,
      },
      transformersjs: {
        modelId: "onnx-community/Llama-3.2-1B-Instruct-ONNX",
        quant: "q4f16",
        dtype: "q4f16",
        approxMb: 1090,
      },
      wllama: {
        modelId: "bartowski/Llama-3.2-1B-Instruct-GGUF",
        file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        quant: "Q4_K_M",
        approxMb: 808,
      },
    },
  },
];

export function getModel(key: ModelKey): ModelSpec {
  const found = MODELS.find((m) => m.key === key);
  if (!found) throw new Error(`unknown model key: ${key}`);
  return found;
}
