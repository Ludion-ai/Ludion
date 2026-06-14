/**
 * ludion-collector — Gate 4 aggregate builder (public data surface).
 *
 * Precomputes the privacy-preserving rollup that `/v1/aggregate` serves O(1)
 * (decisions OQ1/OQ2). The submissions R2 bucket is listed+read ONLY here, never
 * on the read path; the rollup lives in KV (`aggregate:current`), NOT in R2, so it
 * never collides with `pull-submissions` (decisions F-2).
 *
 * Privacy (decisions F-3, acceptance #2): output is derived counts/percentages and
 * suppressed medians ONLY — no UA, no per-device row, nothing that fingerprints a
 * contributor. Speed medians are withheld below K=3 successful runs (k-anonymity).
 *
 * INTENTIONAL DUPLICATION (codebase convention): the ~15-line policy matcher is
 * replicated from `demo/src/verdict.ts` against the single-source `policy.v0.json`,
 * exactly as the router's frozen/unexported evaluator is mirrored elsewhere. The
 * `classifyEnv`/`classifyOsClass` classifiers are likewise copied verbatim from
 * `shared/src/probe.ts` (their own source of truth) — that module cannot be
 * imported here because its `probe*` functions reference DOM-only globals
 * (`navigator.gpu`, `maxTouchPoints`) that do not typecheck under the Worker
 * `WebWorker` lib. Keep this copy byte-faithful; cross-reference when editing.
 */
import policy from "../../router/src/policy.v0.json";
import { median, round } from "../../bench/src/metrics";
import { validateBenchDocument, type BenchDocument } from "../../bench/src/schema";
import type { CollectorEnv } from "./handler";

// --- device classifiers (verbatim copy of shared/src/probe.ts) -----------------

const IAB_UA_TOKENS: readonly RegExp[] = [
  /; wv\)/, // Android WebView marker
  /FB_IAB/,
  /FBAN|FBAV/,
  /Line\//,
  /Instagram/,
  /MicroMessenger/,
  /GSA\//, // Google app in-app browser
];

function classifyEnv(ua: string): "browser" | "webview-iab" {
  return IAB_UA_TOKENS.some((re) => re.test(ua)) ? "webview-iab" : "browser";
}

function classifyOsClass(facts: { ua: string; platform: string; maxTouchPoints: number }): OsClass {
  if (/iPhone|iPad|iPod/.test(facts.ua)) return "ios-webkit";
  if (facts.platform === "MacIntel" && facts.maxTouchPoints > 1) return "ios-webkit";
  if (/Android/.test(facts.ua)) return "android-chromium";
  if (/Windows NT|Macintosh|CrOS|Linux/.test(facts.ua)) return "desktop";
  return "other";
}

type OsClass = "ios-webkit" | "android-chromium" | "desktop" | "other";

export const AGGREGATE_KV_KEY = "aggregate:current";

/**
 * Privacy floor: a speed median is suppressed unless at least this many distinct
 * SUBMISSIONS (devices) contributed a value to it (decisions F-3). Counting devices,
 * not runs, is load-bearing: one device with many runs must never be able to
 * surface its own throughput as a "median" — that would be a per-contributor
 * fingerprint, which Gate 2.7 forbids absolutely.
 */
const K_ANON = 3;

/** Only true submission objects (`YYYY-MM-DD/uuid.json`) enter the rollup (F-2 belt). */
const SUBMISSION_KEY_RE = /^\d{4}-\d{2}-\d{2}\/[0-9a-fA-F-]+\.json$/;

const DEVICE_CLASSES = [
  "desktop",
  "android-chromium",
  "ios-webkit",
  "webview-iab",
  "other",
] as const;
type DeviceClass = (typeof DEVICE_CLASSES)[number];

export interface DeviceClassRollup {
  count: number;
  local_eligible: number;
  completed: number;
  median_decode_tps: number | null;
  median_prefill_tps: number | null;
}

export interface Aggregate {
  schema: "ludion.aggregate.v0";
  updated_at: string | null;
  total_submissions: number;
  by_device_class: Record<DeviceClass, DeviceClassRollup>;
  by_rule: Record<string, number>;
  failure_modes: { completed: number; tab_death: number; init_fail: number; other: number };
}

// --- policy matcher (mirror of demo/src/verdict.ts; representative request) ----

interface RuleJson {
  rule_id: string;
  target: string;
  hw: { env?: string; webgpu?: boolean; os_class?: string };
  request: { max_est_prompt_tokens?: number; max_max_tokens?: number; stream?: boolean };
}

const REPRESENTATIVE = { est_prompt_tokens: 16, max_tokens: 256, stream: true };

function evaluateRule(facts: { webgpu: boolean; env: string; os_class: string }): {
  rule_id: string;
  target: string;
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
    return { rule_id: rule.rule_id, target: rule.target };
  }
  return { rule_id: "R6", target: "server" };
}

// --- builder -------------------------------------------------------------------

function blankRollup(): DeviceClassRollup {
  return {
    count: 0,
    local_eligible: 0,
    completed: 0,
    median_decode_tps: null,
    median_prefill_tps: null,
  };
}

function perClass<T>(init: () => T): Record<DeviceClass, T> {
  return {
    desktop: init(),
    "android-chromium": init(),
    "ios-webkit": init(),
    "webview-iab": init(),
    other: init(),
  };
}

export function emptyAggregate(): Aggregate {
  return {
    schema: "ludion.aggregate.v0",
    updated_at: null,
    total_submissions: 0,
    by_device_class: perClass(blankRollup),
    by_rule: { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 },
    failure_modes: { completed: 0, tab_death: 0, init_fail: 0, other: 0 },
  };
}

/**
 * Pure rollup over validated documents — no I/O, fully unit-testable. The device
 * class is `webview-iab` if the UA is an in-app browser, else the os_class
 * (decisions OQ3). `classifyOsClass` is called with empty platform/touch because
 * submissions store only `device.ua` (F-5 accepted residual: an iPad on a
 * desktop-Safari UA may bucket as desktop in the historical rollup).
 */
export function computeAggregate(docs: BenchDocument[]): Aggregate {
  const agg = emptyAggregate();
  agg.updated_at = new Date().toISOString();
  agg.total_submissions = docs.length;

  const decodeVals = perClass<number[]>(() => []);
  const prefillVals = perClass<number[]>(() => []);
  // Distinct submissions (devices) that contributed ≥1 value to each metric — the
  // k-anonymity denominator (F-3). NOT a run count.
  const decodeDevices = perClass<number>(() => 0);
  const prefillDevices = perClass<number>(() => 0);

  for (const doc of docs) {
    const ua = doc.device.ua;
    const env = classifyEnv(ua);
    const os_class = classifyOsClass({ ua, platform: "", maxTouchPoints: 0 });
    const cls: DeviceClass = env === "webview-iab" ? "webview-iab" : os_class;
    const { rule_id, target } = evaluateRule({ webgpu: doc.device.webgpu, env, os_class });

    const bucket = agg.by_device_class[cls];
    bucket.count += 1;
    if (target === "local") bucket.local_eligible += 1;

    const okRuns = doc.runs.filter((r) => r.error === null);
    const completed = okRuns.length > 0;
    if (completed) bucket.completed += 1;

    let contributedDecode = false;
    let contributedPrefill = false;
    for (const r of okRuns) {
      if (r.decode_tps !== null) {
        decodeVals[cls].push(r.decode_tps);
        contributedDecode = true;
      }
      if (r.prefill_tps !== null) {
        prefillVals[cls].push(r.prefill_tps);
        contributedPrefill = true;
      }
    }
    if (contributedDecode) decodeDevices[cls] += 1;
    if (contributedPrefill) prefillDevices[cls] += 1;

    agg.by_rule[rule_id] = (agg.by_rule[rule_id] ?? 0) + 1;

    if (completed) {
      agg.failure_modes.completed += 1;
    } else if (doc.runs.some((r) => r.error !== null && /oom|tab_kill/i.test(r.error.error_name))) {
      agg.failure_modes.tab_death += 1;
    } else if (doc.runs.some((r) => r.error !== null && r.error.stage === "init")) {
      agg.failure_modes.init_fail += 1;
    } else {
      agg.failure_modes.other += 1;
    }
  }

  for (const cls of DEVICE_CLASSES) {
    if (decodeDevices[cls] >= K_ANON) {
      agg.by_device_class[cls].median_decode_tps = round(median(decodeVals[cls]));
    }
    if (prefillDevices[cls] >= K_ANON) {
      agg.by_device_class[cls].median_prefill_tps = round(median(prefillVals[cls]));
    }
  }

  return agg;
}

/**
 * Read every submission object, recompute, and persist the rollup to KV. The ONLY
 * place R2 is listed (decisions OQ2). Called off the response path via
 * `ctx.waitUntil` on each new submit, and from the scheduled() Cron handler.
 */
export async function rebuildAggregate(env: CollectorEnv): Promise<Aggregate> {
  const docs: BenchDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SUBMISSIONS.list(cursor !== undefined ? { cursor } : undefined);
    for (const obj of page.objects) {
      if (!SUBMISSION_KEY_RE.test(obj.key)) continue; // F-2 defensive belt
      const stored = await env.SUBMISSIONS.get(obj.key);
      if (stored === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await stored.text());
      } catch {
        continue;
      }
      if (!validateBenchDocument(parsed).ok) continue;
      docs.push(parsed as BenchDocument);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  const agg = computeAggregate(docs);
  try {
    await env.COLLECTOR_KV.put(AGGREGATE_KV_KEY, JSON.stringify(agg));
  } catch {
    // KV write failure: the next rebuild retries; the read path serves the prior
    // value (or the empty shell), never an error.
  }
  return agg;
}

/** Read the precomputed rollup; empty-but-valid shell if never built (decisions OQ2/F-6). */
export async function readAggregate(env: CollectorEnv): Promise<Aggregate> {
  const raw = await env.COLLECTOR_KV.get(AGGREGATE_KV_KEY);
  if (raw === null) return emptyAggregate();
  try {
    return JSON.parse(raw) as Aggregate;
  } catch {
    return emptyAggregate();
  }
}
