/** Pure metric math — kept separate so it is unit-testable without a browser. */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * prefill_tps = tokens_in / (first-token time - generation start).
 * Known approximation: the denominator includes the first decode step.
 */
export function prefillTps(tokensIn: number | null, ttftMs: number | null): number | null {
  if (tokensIn === null || ttftMs === null || ttftMs <= 0) return null;
  return tokensIn / (ttftMs / 1000);
}

/**
 * decode_tps = (tokens_out - 1) / (last-token time - first-token time).
 * Returns null when tokens_out <= 1 or the interval is non-positive
 * (division-by-zero fix approved at spec review).
 */
export function decodeTps(
  tokensOut: number | null,
  firstTokenMs: number | null,
  lastTokenMs: number | null,
): number | null {
  if (tokensOut === null || tokensOut <= 1) return null;
  if (firstTokenMs === null || lastTokenMs === null) return null;
  const intervalMs = lastTokenMs - firstTokenMs;
  if (intervalMs <= 0) return null;
  return (tokensOut - 1) / (intervalMs / 1000);
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
