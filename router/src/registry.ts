/**
 * Model registry core (Spec C step 1): the single validated source of model
 * IDENTITY that every later piece references (fallback picker, PolicyTable
 * model refs, on-device auto-assignment, the telemetry flywheel). After this,
 * nothing else in the codebase should define model identity independently.
 *
 * This module ships a clean "model ledger" (registry.json) and its accessors.
 * No UI, no selection logic, no auto-assignment — those are later specs.
 *
 * Design boundaries (challenged and affirmed at review):
 *  - STATIC only. The registry holds authorable facts (id, provider, kind,
 *    context length, on-device capability, params/memory hint/WebLLM id). It
 *    holds NO measured device performance: that is bench data, kept as a
 *    SEPARATE layer and JOINED, not merged. Join keys:
 *      local `id`              <-> bench `ModelKey`
 *      local `webllm_model_id` <-> bench `RunRow.model_id` (WebLLM-engine runs)
 *  - PRICES are NOT absorbed. pricing.json stays the backing store (its
 *    `verified`/`source`/`price_as_of` authority and the /savings read-path are
 *    untouched). An api entry carries `pricing_ref` -> a pricing.json row id;
 *    `getModelPricing()` performs the join. So pricing behavior is byte
 *    identical to before this module existed.
 *
 * Authored data fails LOUD: a malformed/duplicated/out-of-version entry (or a
 * pricing_ref that resolves to no price row) throws LudionRegistryError at
 * module load, never silently resolving a wrong model later.
 */
import { LudionRegistryError } from "./errors";
import { PRESET_PRICING } from "./pricing";
import type { PriceRow } from "./pricing";
import registryData from "./registry.json";

/** Bumped when the registry schema changes incompatibly. */
export const MODEL_REGISTRY_VERSION = 2;

/** How a model can be reached. A model may later be both-eligible; today each entry is one. */
export type ModelKind = "api" | "local";

/** A single static model entry. Measured perf and price numbers live elsewhere (see module doc). */
export interface ModelEntry {
  /** Stable canonical id. Join key to bench ModelKey for local models. */
  id: string;
  display_name: string;
  /** openai / anthropic / google / oss-local / ... */
  provider: string;
  kind: ModelKind;
  /** Published nominal context window (tokens). Not independently re-verified. */
  context_length: number;
  /** Static capability flag: candidate for local execution at all (NOT a per-device measurement). */
  on_device_capable: boolean;
  /** api only: id of the pricing.json row that backs this model's price. */
  pricing_ref?: string;
  /**
   * api only (required for kind:"api"): the exact string the provider's API
   * expects in the `model` param. Distinct from `id`, which is an internal
   * canonical handle: e.g. id "claude-sonnet" -> provider_model_id
   * "claude-sonnet-4-6". This is what a fallback request actually sends.
   */
  provider_model_id?: string;
  /**
   * api only (required for kind:"api"): true only when provider_model_id is
   * confirmed against the provider's model-id reference. false marks a
   * best-known value pending verification; consumers must not send an
   * unverified string automatically (the picker withholds it).
   */
  provider_model_id_verified?: boolean;
  /** local only (required iff on_device_capable): e.g. "1.5B". */
  params?: string;
  /** local only (required iff on_device_capable): approx resident weights size, MB. */
  min_memory_hint_mb?: number;
  /** local only (required iff on_device_capable): the WebLLM model id. Join key to bench RunRow.model_id. */
  webllm_model_id?: string;
}

export interface ModelRegistry {
  registry_version: number;
  note: string;
  models: ModelEntry[];
}

/** Read filter for listModels(). All clauses AND together; omitted clauses match all. */
export interface ModelFilter {
  provider?: string;
  kind?: ModelKind;
  on_device_capable?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Validate a candidate registry. Throws LudionRegistryError on the first
 * problem (authored data, so fail loud and specific). Returns the typed
 * registry on success.
 */
export function validateModelRegistry(input: unknown): ModelRegistry {
  if (typeof input !== "object" || input === null) {
    throw new LudionRegistryError("registry is not an object");
  }
  const reg = input as Record<string, unknown>;
  if (reg.registry_version !== MODEL_REGISTRY_VERSION) {
    throw new LudionRegistryError(
      `unsupported registry_version ${String(reg.registry_version)} (expected ${MODEL_REGISTRY_VERSION})`,
    );
  }
  if (!isNonEmptyString(reg.note)) {
    throw new LudionRegistryError("note must be a non-empty string");
  }
  if (!Array.isArray(reg.models) || reg.models.length === 0) {
    throw new LudionRegistryError("models must be a non-empty array");
  }

  const priceIds = new Set(PRESET_PRICING.models.map((m) => m.id));
  const seenIds = new Set<string>();
  const seenWebllm = new Set<string>();

  for (const raw of reg.models) {
    if (typeof raw !== "object" || raw === null) {
      throw new LudionRegistryError("each model must be an object");
    }
    const m = raw as Record<string, unknown>;
    const id = m.id;
    if (!isNonEmptyString(id)) {
      throw new LudionRegistryError("model id must be a non-empty string");
    }
    if (seenIds.has(id)) {
      throw new LudionRegistryError(`duplicate model id: ${id}`);
    }
    seenIds.add(id);

    if (!isNonEmptyString(m.display_name)) {
      throw new LudionRegistryError(`${id}: display_name must be a non-empty string`);
    }
    if (!isNonEmptyString(m.provider)) {
      throw new LudionRegistryError(`${id}: provider must be a non-empty string`);
    }
    if (m.kind !== "api" && m.kind !== "local") {
      throw new LudionRegistryError(`${id}: kind must be "api" or "local"`);
    }
    if (!isPositiveNumber(m.context_length)) {
      throw new LudionRegistryError(`${id}: context_length must be a positive number`);
    }
    if (typeof m.on_device_capable !== "boolean") {
      throw new LudionRegistryError(`${id}: on_device_capable must be a boolean`);
    }

    if (m.on_device_capable) {
      if (!isNonEmptyString(m.webllm_model_id)) {
        throw new LudionRegistryError(`${id}: on_device_capable requires a webllm_model_id`);
      }
      if (seenWebllm.has(m.webllm_model_id)) {
        throw new LudionRegistryError(`duplicate webllm_model_id: ${m.webllm_model_id}`);
      }
      seenWebllm.add(m.webllm_model_id);
      if (!isNonEmptyString(m.params)) {
        throw new LudionRegistryError(`${id}: on_device_capable requires params`);
      }
      if (!isPositiveNumber(m.min_memory_hint_mb)) {
        throw new LudionRegistryError(`${id}: on_device_capable requires a positive min_memory_hint_mb`);
      }
    } else if (m.webllm_model_id !== undefined) {
      throw new LudionRegistryError(`${id}: webllm_model_id is only valid when on_device_capable is true`);
    }

    if (m.pricing_ref !== undefined) {
      if (!isNonEmptyString(m.pricing_ref)) {
        throw new LudionRegistryError(`${id}: pricing_ref must be a non-empty string`);
      }
      if (!priceIds.has(m.pricing_ref)) {
        throw new LudionRegistryError(`${id}: pricing_ref "${m.pricing_ref}" matches no pricing.json row`);
      }
    }

    if (m.kind === "api") {
      if (!isNonEmptyString(m.provider_model_id)) {
        throw new LudionRegistryError(`${id}: kind "api" requires a provider_model_id`);
      }
      if (typeof m.provider_model_id_verified !== "boolean") {
        throw new LudionRegistryError(`${id}: kind "api" requires a boolean provider_model_id_verified`);
      }
    }
  }

  return input as ModelRegistry;
}

/** The bundled registry, validated at module load (fail loud on malformed authored data). */
export const MODEL_REGISTRY: ModelRegistry = validateModelRegistry(registryData);

/** Look up a model by canonical id. Returns undefined if not present. */
export function getModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.models.find((m) => m.id === id);
}

/** List models, optionally filtered by provider / kind / on_device_capable (clauses AND). */
export function listModels(filter?: ModelFilter): ModelEntry[] {
  if (filter === undefined) return MODEL_REGISTRY.models.slice();
  return MODEL_REGISTRY.models.filter(
    (m) =>
      (filter.provider === undefined || m.provider === filter.provider) &&
      (filter.kind === undefined || m.kind === filter.kind) &&
      (filter.on_device_capable === undefined || m.on_device_capable === filter.on_device_capable),
  );
}

/**
 * Resolve a model's price row THROUGH the registry: joins the entry's
 * `pricing_ref` into pricing.json (PRESET_PRICING). Returns undefined if the
 * model is unknown or carries no pricing_ref (e.g. a local-only model). Price
 * authority/verification stays in pricing.json — this is a read-only join.
 */
export function getModelPricing(id: string): PriceRow | undefined {
  const ref = getModel(id)?.pricing_ref;
  if (ref === undefined) return undefined;
  return PRESET_PRICING.models.find((p) => p.id === ref);
}
