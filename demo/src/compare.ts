/**
 * Gate 4 ① — one-line crowd comparison shown after the probe.
 *
 * Turns the visitor's own verdict into "where do I land vs everyone measured
 * here", read from the public /v1/aggregate rollup. Degrades to `null` (the caller
 * shows the local verdict alone, no error) whenever the endpoint is unreachable,
 * unconfigured, or empty (decisions F-6).
 *
 * The response type is a minimal read-only subset; the authoritative aggregate
 * shape lives in collector/src/aggregate.ts. The formatter is duplicated in
 * bench/src/compare.ts (bench is deliberately independent) — keep them in sync.
 */

interface ClassRollup {
  count: number;
  local_eligible: number;
  completed: number;
  median_decode_tps: number | null;
}
interface AggregateResponse {
  total_submissions: number;
  by_device_class: Record<string, ClassRollup>;
}

const CLASS_NOUN: Record<string, string> = {
  desktop: "desktops",
  "android-chromium": "Android devices",
  "ios-webkit": "iOS devices",
  "webview-iab": "in-app browsers",
  other: "other devices",
};

export function collectorUrl(): string | null {
  const url = import.meta.env.VITE_COLLECTOR_URL as string | undefined;
  if (!url || url.includes("<account>")) return null;
  return url.replace(/\/$/, "");
}

export async function fetchAggregate(): Promise<AggregateResponse | null> {
  const base = collectorUrl();
  if (base === null) return null;
  try {
    const res = await fetch(`${base}/v1/aggregate`);
    if (!res.ok) return null;
    return (await res.json()) as AggregateResponse;
  } catch {
    return null;
  }
}

/** Map probe (env + os_class) to the 5 public device classes (decisions OQ3). */
export function deviceClassOf(env: string, osClass: string): string {
  return env === "webview-iab" ? "webview-iab" : osClass;
}

function singular(noun: string): string {
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}

export function comparisonLine(opts: {
  deviceClass: string;
  ruleId: string;
  target: "local" | "server";
  aggregate: AggregateResponse | null;
  measuredDecodeTps?: number | null;
}): string | null {
  const { deviceClass, ruleId, target, aggregate, measuredDecodeTps } = opts;
  if (aggregate === null) return null;
  const noun = CLASS_NOUN[deviceClass] ?? "devices";
  const roll = aggregate.by_device_class[deviceClass];
  if (!roll || roll.count === 0) {
    return target === "local"
      ? `You're the first ${singular(noun)} measured here (${ruleId}).`
      : `No other ${noun} measured here yet (${ruleId}).`;
  }
  if (target === "local") {
    const pct = Math.round((roll.local_eligible / roll.count) * 100);
    const med = roll.median_decode_tps;
    const medPart = med !== null ? ` Median ${noun} decode ~${med} tok/s.` : "";
    const youPart =
      measuredDecodeTps != null && measuredDecodeTps !== 0
        ? ` You got ~${Math.round(measuredDecodeTps * 10) / 10} tok/s.`
        : "";
    return `~${pct}% of ${noun} measured here are LOCAL-eligible too.${medPart}${youPart}`;
  }
  return `So did ${noun} measured here — ${roll.completed} of ${roll.count} completed a local run.`;
}
