/**
 * entelic.bench.v0 — stable result schema (versioned contract).
 *
 * Amendments approved at spec review (2026-06-10):
 *  - runs[].backend: 3-value enum ("webgpu" | "wasm-singlethread" | "wasm-multithread").
 *    wllama / Transformers.js silently switch execution paths per platform; without
 *    this field rows are not comparable.
 *  - battery moved from top level into sessions[] (battery_start / battery_end),
 *    because the reload-between-engines flow makes a whole-suite in-memory delta
 *    impossible.
 *  - download_mb is number|null and timing_source records whether the
 *    download/init split came from the engine or was estimated (WebLLM conflates
 *    fetch+compile inside reload(); the split is parsed from progress text).
 *  - decode_tps is null when tokens_out <= 1 (division by zero otherwise).
 *  - Metric fields are nullable so error rows fit the same row shape.
 *  - kv_context_window / prefill_chunk (added 2026-06-10): KV-cache sizing in
 *    effect is a measurement condition (WebLLM preallocates KV at the full
 *    context window — capped to 2048 to test the 4 GB-iPhone OOM hypothesis).
 *    null where the engine does not expose / we do not control it.
 */

export const SCHEMA_ID = "entelic.bench.v0" as const;

export type EngineId = "webllm" | "transformersjs" | "wllama";
export type Backend = "webgpu" | "wasm-singlethread" | "wasm-multithread";
export type PromptId = "short" | "long-context";
export type CacheState = "cold" | "warm";
export type FailStage = "download" | "init" | "generate";
export type MetricSource = "engine" | "estimated";

export interface BenchError {
  stage: FailStage;
  error_name: string;
  error_message: string;
}

export interface AdapterInfo {
  vendor: string;
  architecture: string;
  f16: boolean;
  maxBufferSize: number;
  limitsRaw: Record<string, number>;
}

export interface DeviceInfo {
  ua: string;
  webgpu: boolean;
  adapter: AdapterInfo | null;
  hw_concurrency: number;
  device_memory_gb: number | null;
  screen: string;
  operator_label: string;
}

export interface SessionRow {
  engine: EngineId;
  model_id: string;
  cache_state: CacheState;
  started_at: string;
  ended_at: string | null;
  battery_start: number | null;
  battery_end: number | null;
}

export interface RunRow {
  engine: EngineId;
  engine_version: string;
  backend: Backend | null; // null if failure occurred before the backend was known
  model_id: string;
  quant: string;
  prompt: PromptId;
  cache_state: CacheState;
  download_ms: number | null;
  download_mb: number | null;
  init_ms: number | null;
  ttft_ms: number | null;
  prefill_tps: number | null;
  decode_tps: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  token_count_source: MetricSource | null;
  timing_source: MetricSource | null;
  peak_mem_mb: number | null;
  kv_context_window: number | null;
  prefill_chunk: number | null;
  error: BenchError | null;
}

export interface BenchDocument {
  schema: typeof SCHEMA_ID;
  collected_at: string;
  device: DeviceInfo;
  sessions: SessionRow[];
  runs: RunRow[];
  operator_notes: string;
}

// ---------------------------------------------------------------------------
// Runtime validator (acceptance criterion 3). Hand-rolled: no deps, tiny.
// ---------------------------------------------------------------------------

const ENGINES: readonly string[] = ["webllm", "transformersjs", "wllama"];
const BACKENDS: readonly string[] = ["webgpu", "wasm-singlethread", "wasm-multithread"];
const PROMPTS: readonly string[] = ["short", "long-context"];
const CACHE_STATES: readonly string[] = ["cold", "warm"];
const STAGES: readonly string[] = ["download", "init", "generate"];
const SOURCES: readonly string[] = ["engine", "estimated"];

type Check = (v: unknown) => boolean;

const isStr: Check = (v) => typeof v === "string";
const isBool: Check = (v) => typeof v === "boolean";
const isNum: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isNumOrNull: Check = (v) => v === null || isNum(v);
const isStrOrNull: Check = (v) => v === null || isStr(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf =
  (allowed: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v);
const orNull =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);

function checkFields(
  obj: Record<string, unknown>,
  path: string,
  fields: Record<string, Check>,
  errors: string[],
): void {
  for (const [key, check] of Object.entries(fields)) {
    if (!(key in obj)) {
      errors.push(`${path}.${key}: missing`);
    } else if (!check(obj[key])) {
      errors.push(`${path}.${key}: invalid value ${JSON.stringify(obj[key])}`);
    }
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateBenchDocument(doc: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(doc)) return { ok: false, errors: ["document: not an object"] };

  checkFields(
    doc,
    "$",
    {
      schema: (v) => v === SCHEMA_ID,
      collected_at: isStr,
      operator_notes: isStr,
    },
    errors,
  );

  // device
  if (!isObj(doc.device)) {
    errors.push("$.device: not an object");
  } else {
    checkFields(
      doc.device,
      "$.device",
      {
        ua: isStr,
        webgpu: isBool,
        hw_concurrency: isNum,
        device_memory_gb: isNumOrNull,
        screen: isStr,
        operator_label: isStr,
      },
      errors,
    );
    const adapter = doc.device.adapter;
    if (adapter !== null) {
      if (!isObj(adapter)) {
        errors.push("$.device.adapter: not an object or null");
      } else {
        checkFields(
          adapter,
          "$.device.adapter",
          { vendor: isStr, architecture: isStr, f16: isBool, maxBufferSize: isNum },
          errors,
        );
        if (!isObj(adapter.limitsRaw)) {
          errors.push("$.device.adapter.limitsRaw: not an object");
        }
      }
    }
  }

  // sessions
  if (!Array.isArray(doc.sessions)) {
    errors.push("$.sessions: not an array");
  } else {
    doc.sessions.forEach((s, i) => {
      const path = `$.sessions[${i}]`;
      if (!isObj(s)) {
        errors.push(`${path}: not an object`);
        return;
      }
      checkFields(
        s,
        path,
        {
          engine: oneOf(ENGINES),
          model_id: isStr,
          cache_state: oneOf(CACHE_STATES),
          started_at: isStr,
          ended_at: isStrOrNull,
          battery_start: isNumOrNull,
          battery_end: isNumOrNull,
        },
        errors,
      );
    });
  }

  // runs
  if (!Array.isArray(doc.runs)) {
    errors.push("$.runs: not an array");
  } else {
    doc.runs.forEach((r, i) => {
      const path = `$.runs[${i}]`;
      if (!isObj(r)) {
        errors.push(`${path}: not an object`);
        return;
      }
      checkFields(
        r,
        path,
        {
          engine: oneOf(ENGINES),
          engine_version: isStr,
          backend: orNull(oneOf(BACKENDS)),
          model_id: isStr,
          quant: isStr,
          prompt: oneOf(PROMPTS),
          cache_state: oneOf(CACHE_STATES),
          download_ms: isNumOrNull,
          download_mb: isNumOrNull,
          init_ms: isNumOrNull,
          ttft_ms: isNumOrNull,
          prefill_tps: isNumOrNull,
          decode_tps: isNumOrNull,
          tokens_in: isNumOrNull,
          tokens_out: isNumOrNull,
          token_count_source: orNull(oneOf(SOURCES)),
          timing_source: orNull(oneOf(SOURCES)),
          peak_mem_mb: isNumOrNull,
          kv_context_window: isNumOrNull,
          prefill_chunk: isNumOrNull,
        },
        errors,
      );
      const err = r.error;
      if (err !== null && err !== undefined) {
        if (!isObj(err)) {
          errors.push(`${path}.error: not an object or null`);
        } else {
          checkFields(
            err,
            `${path}.error`,
            { stage: oneOf(STAGES), error_name: isStr, error_message: isStr },
            errors,
          );
        }
      } else if (err === undefined) {
        errors.push(`${path}.error: missing`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
