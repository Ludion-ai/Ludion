/**
 * Gate 4 ① — one-line crowd comparison shown after a measurement completes.
 *
 * Bench is deliberately independent of @ludion/shared and the router package
 * (Gate 0 measurement comparability is guaranteed by NOT importing them). So the
 * two pure device classifiers are copied verbatim from shared/src/probe.ts and the
 * ~15-line policy matcher is duplicated against the single-source policy.v0.json,
 * exactly as demo/src/verdict.ts does. The aggregate fetch + formatter are kept in
 * sync with demo/src/compare.ts. Keep these copies byte-faithful; cross-reference
 * when editing.
 *
 * Degrades to `null` (caller shows the local verdict alone, no error) whenever the
 * endpoint is unreachable, unconfigured, or empty (decisions F-6).
 */
import policy from "../../router/src/policy.v0.json";
import { collectorUrl } from "./submit";
import { median } from "./metrics";
import type { DeviceInfo, RunRow } from "./schema";

// --- device classifiers (verbatim copy of shared/src/probe.ts) -----------------

const IAB_UA_TOKENS: readonly RegExp[] = [
  /; wv\)/,
  /FB_IAB/,
  /FBAN|FBAV/,
  /Line\//,
  /Instagram/,
  /MicroMessenger/,
  /GSA\//,
];

function classifyEnv(ua: string): "browser" | "webview-iab" {
  return IAB_UA_TOKENS.some((re) => re.test(ua)) ? "webview-iab" : "browser";
}

type OsClass = "ios-webkit" | "android-chromium" | "desktop" | "other";

function classifyOsClass(facts: { ua: string; platform: string; maxTouchPoints: number }): OsClass {
  if (/iPhone|iPad|iPod/.test(facts.ua)) return "ios-webkit";
  if (facts.platform === "MacIntel" && facts.maxTouchPoints > 1) return "ios-webkit";
  if (/Android/.test(facts.ua)) return "android-chromium";
  if (/Windows NT|Macintosh|CrOS|Linux/.test(facts.ua)) return "desktop";
  return "other";
}

// --- policy matcher (mirror of demo/src/verdict.ts; representative request) -----

interface RuleJson {
  rule_id: string;
  target: string;
  hw: { env?: string; webgpu?: boolean; os_class?: string };
  request: { max_est_prompt_tokens?: number; max_max_tokens?: number; stream?: boolean };
}

const REPRESENTATIVE = { est_prompt_tokens: 16, max_tokens: 256, stream: true };

function evaluateRule(facts: { webgpu: boolean; env: string; os_class: string }): {
  rule_id: string;
  target: "local" | "server";
} {
  for (const rule of policy.rules as RuleJson[]) {
    const hw = rule.hw;
    if (hw.env !== undefined && hw.env !== facts.env) continue;
    if (hw.webgpu !== undefined && hw.webgpu !== facts.webgpu) continue;
    if (hw.os_class !== undefined && hw.os_class !== facts.os_class) continue;
    const req = rule.request;
    if (
      req.max_est_prompt_tokens !== undefined &&
      REPRESENTATIVE.est_prompt_tokens > req.max_est_prompt_tokens
    )
      continue;
    if (req.max_max_tokens !== undefined && REPRESENTATIVE.max_tokens > req.max_max_tokens) continue;
    if (req.stream !== undefined && req.stream !== REPRESENTATIVE.stream) continue;
    return { rule_id: rule.rule_id, target: rule.target as "local" | "server" };
  }
  return { rule_id: "R6", target: "server" };
}

// --- aggregate fetch + formatter (in sync with demo/src/compare.ts) -------------

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

async function fetchAggregate(): Promise<AggregateResponse | null> {
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

function singular(noun: string): string {
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}

function comparisonLine(opts: {
  deviceClass: string;
  ruleId: string;
  target: "local" | "server";
  aggregate: AggregateResponse | null;
  measuredDecodeTps: number | null;
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
      measuredDecodeTps !== null && measuredDecodeTps !== 0
        ? ` You got ~${Math.round(measuredDecodeTps * 10) / 10} tok/s.`
        : "";
    return `~${pct}% of ${noun} measured here are LOCAL-eligible too (${ruleId}).${medPart}${youPart}`;
  }
  return `Routed to server (${ruleId}). So did ${noun} measured here — ${roll.completed} of ${roll.count} completed a local run.`;
}

/**
 * Compute this device's class + verdict, fetch the crowd aggregate, and return the
 * comparison line (or `null` to degrade). `measuredDecodeTps` is the median of this
 * run's successful decode rates (decisions OQ4 — failed runs excluded).
 */
export async function buildComparison(device: DeviceInfo, runs: RunRow[]): Promise<string | null> {
  const ua = device.ua;
  const env = classifyEnv(ua);
  const os_class = classifyOsClass({
    ua,
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
  const deviceClass = env === "webview-iab" ? "webview-iab" : os_class;
  const { rule_id, target } = evaluateRule({ webgpu: device.webgpu, env, os_class });

  const decodeVals = runs
    .filter((r) => r.error === null)
    .map((r) => r.decode_tps)
    .filter((v): v is number => v !== null);
  const measured = median(decodeVals);

  const aggregate = await fetchAggregate();
  return comparisonLine({
    deviceClass,
    ruleId: rule_id,
    target,
    aggregate,
    measuredDecodeTps: measured,
  });
}
