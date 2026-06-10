import { describe, expect, it } from "vitest";
import { estimatePromptTokens } from "../src/tokens";

describe("estimatePromptTokens (Q4 CJK-weighted)", () => {
  it("English ≈ chars/4", () => {
    // 40 ASCII chars → 10
    const msg = [{ role: "user" as const, content: "a".repeat(40) }];
    expect(estimatePromptTokens(msg)).toBe(10);
  });

  it("Japanese ≈ 1 token/char (A-4: chars/4 would be ~4x under)", () => {
    const jp = "東京は今日もいい天気ですね"; // 13 CJK chars
    expect(estimatePromptTokens([{ role: "user", content: jp }])).toBe(13);
  });

  it("mixed content is the weighted sum, ceiled", () => {
    // "日本語です abcdef": 5 CJK + 7 other → 5 + 1.75 → ceil 7
    expect(estimatePromptTokens([{ role: "user", content: "日本語です abcdef" }])).toBe(7);
  });

  it("explicit mixed value", () => {
    // "漢字test": 2 CJK + 4 ASCII → 2 + 1 = 3
    expect(estimatePromptTokens([{ role: "user", content: "漢字test" }])).toBe(3);
  });

  it("Hangul and Katakana count as CJK", () => {
    expect(estimatePromptTokens([{ role: "user", content: "한국어" }])).toBe(3);
    expect(estimatePromptTokens([{ role: "user", content: "カタカナ" }])).toBe(4);
  });

  it("sums across messages; empty → 0", () => {
    expect(estimatePromptTokens([])).toBe(0);
    expect(
      estimatePromptTokens([
        { role: "system", content: "abcd" },
        { role: "user", content: "efgh" },
      ]),
    ).toBe(2);
  });

  it("is deterministic", () => {
    const msgs = [{ role: "user" as const, content: "mixed 日本語 and English コード" }];
    expect(estimatePromptTokens(msgs)).toBe(estimatePromptTokens(msgs));
  });
});
