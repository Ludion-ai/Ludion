import { describe, expect, it } from "vitest";
import { getModel, MODELS } from "../src/models";

describe("model triples", () => {
  it("every model resolves a ref for all three engines", () => {
    for (const spec of MODELS) {
      for (const engine of ["webllm", "transformersjs", "wllama"] as const) {
        const ref = spec.engines[engine];
        expect(ref.modelId).toBeTruthy();
        expect(ref.quant).toBeTruthy();
        expect(ref.approxMb).toBeGreaterThan(0);
      }
      // wllama needs an explicit GGUF file within the repo.
      expect(spec.engines.wllama.file).toMatch(/\.gguf$/);
    }
  });

  it("floor triple (Qwen2.5-0.5B) is registered with verified artifact ids", () => {
    const floor = getModel("qwen2.5-0.5b");
    expect(floor.engines.webllm.modelId).toBe("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
    expect(floor.engines.transformersjs.modelId).toBe("onnx-community/Qwen2.5-0.5B-Instruct");
    expect(floor.engines.wllama.modelId).toBe("bartowski/Qwen2.5-0.5B-Instruct-GGUF");
    expect(floor.engines.wllama.file).toBe("Qwen2.5-0.5B-Instruct-Q4_K_M.gguf");
    // Floor must actually be smaller than the 1B tier on every engine.
    const llama = getModel("llama-3.2-1b");
    for (const engine of ["webllm", "transformersjs", "wllama"] as const) {
      expect(floor.engines[engine].approxMb).toBeLessThan(llama.engines[engine].approxMb);
    }
  });
});
