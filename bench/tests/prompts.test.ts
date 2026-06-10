import { describe, expect, it } from "vitest";
import { PROMPTS } from "../src/prompts";
import { KV_CONTEXT_WINDOW } from "../src/adapters/webllm";

describe("prompts fit the WebLLM KV context window override", () => {
  it("worst-case token estimate + max_tokens + template overhead <= 2048", () => {
    // chars/4 deliberately over-estimates English text (real tokenizer count
    // for the long prompt is ~1350; chars/4 gives ~1757). Chat template
    // overhead is generously budgeted at 64 tokens.
    const TEMPLATE_OVERHEAD = 64;
    for (const prompt of PROMPTS) {
      const worstCaseTokensIn = Math.ceil(prompt.text.length / 4);
      expect(worstCaseTokensIn + prompt.maxTokens + TEMPLATE_OVERHEAD).toBeLessThanOrEqual(
        KV_CONTEXT_WINDOW,
      );
    }
  });
});
