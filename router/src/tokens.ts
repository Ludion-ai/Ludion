import type { ChatMessage } from "@entelic/shared";

/**
 * CJK-weighted prompt token estimate (Gate 1 decisions Q4, A-4).
 *
 *   est = ceil(cjk_chars × 1.0 + other_chars / 4)
 *
 * Rationale: plain chars/4 under-estimates CJK by ~4x (Japanese ≈ 1
 * token/char) and that error falls on the DANGEROUS side — a long Japanese
 * prompt mis-routed local on a Pixel-class device means ~77 s TTFT. The
 * weighted estimate biases every error toward server, which is the safe side.
 *
 * Documented error bars (vs real tokenizers):
 *  - English prose: +20–35% over-estimate (safe side)
 *  - Japanese: ±15%
 *  - Mixed code: −10% to +30%
 *
 * Deterministic: one regex over message contents, no tokenizer download.
 * Per-message chat-template overhead is deliberately ignored (absorbed by the
 * server-side bias).
 */

// Han (incl. Ext-A, compatibility), Hiragana, Katakana, Hangul — range
// literals, single regex (decisions Q4).
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function estimatePromptTokens(messages: readonly ChatMessage[]): number {
  let cjk = 0;
  let total = 0;
  for (const m of messages) {
    total += m.content.length;
    cjk += m.content.match(CJK_RE)?.length ?? 0;
  }
  const other = total - cjk;
  return Math.ceil(cjk + other / 4);
}
