/** Display size for a claim used as a headline: long claims step down so 400 characters still read as one thought. */
export function claimSize(claim: string): "xl" | "l" | "m" | "s" {
  const n = claim.length;
  if (n <= 70) return "xl";
  if (n <= 150) return "l";
  if (n <= 260) return "m";
  return "s";
}
