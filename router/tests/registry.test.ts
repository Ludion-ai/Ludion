import { describe, expect, it } from "vitest";
import { LudionRegistryError } from "../src/errors";
import { PRESET_PRICING } from "../src/pricing";
import {
  MODEL_REGISTRY,
  MODEL_REGISTRY_VERSION,
  getModel,
  getModelPricing,
  listModels,
  validateModelRegistry,
} from "../src/registry";
import type { ModelEntry, ModelRegistry } from "../src/registry";

// A minimal valid registry built fresh per test, so mutations stay local.
function validRegistry(): ModelRegistry {
  return {
    registry_version: MODEL_REGISTRY_VERSION,
    note: "test fixture",
    models: [
      {
        id: "gpt-4o",
        display_name: "GPT-4o",
        provider: "openai",
        kind: "api",
        context_length: 128000,
        on_device_capable: false,
        pricing_ref: "gpt-4o",
        provider_model_id: "gpt-4o",
        provider_model_id_verified: true,
      },
      {
        id: "llama-3.2-1b",
        display_name: "Llama-3.2-1B-Instruct",
        provider: "oss-local",
        kind: "local",
        context_length: 131072,
        on_device_capable: true,
        params: "1B",
        min_memory_hint_mb: 695,
        webllm_model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      },
    ],
  };
}

describe("model registry: bundled data loads and validates", () => {
  it("the shipped registry validates at load and has the expected version", () => {
    expect(MODEL_REGISTRY.registry_version).toBe(MODEL_REGISTRY_VERSION);
    expect(MODEL_REGISTRY.models.length).toBeGreaterThan(0);
  });

  it("every api entry's pricing_ref resolves to a pricing.json row (the join is intact)", () => {
    const priceIds = new Set(PRESET_PRICING.models.map((p) => p.id));
    for (const m of MODEL_REGISTRY.models) {
      if (m.pricing_ref !== undefined) expect(priceIds.has(m.pricing_ref)).toBe(true);
    }
  });

  it("every api entry carries a provider_model_id and a verified flag", () => {
    for (const m of MODEL_REGISTRY.models) {
      if (m.kind === "api") {
        expect(typeof m.provider_model_id).toBe("string");
        expect(m.provider_model_id!.length).toBeGreaterThan(0);
        expect(typeof m.provider_model_id_verified).toBe("boolean");
      }
    }
  });

  it("every on-device-capable entry carries params, memory hint, and a webllm id", () => {
    for (const m of MODEL_REGISTRY.models) {
      if (m.on_device_capable) {
        expect(m.webllm_model_id).toBeTruthy();
        expect(m.params).toBeTruthy();
        expect(typeof m.min_memory_hint_mb).toBe("number");
      }
    }
  });
});

describe("model registry: accessors", () => {
  it("getModel returns the entry by id, or undefined", () => {
    expect(getModel("llama-3.2-1b")?.kind).toBe("local");
    expect(getModel("nope")).toBeUndefined();
  });

  it("listModels() returns all; filters AND together", () => {
    const all = listModels();
    expect(all.length).toBe(MODEL_REGISTRY.models.length);

    const local = listModels({ kind: "local" });
    expect(local.every((m) => m.kind === "local")).toBe(true);

    const onDeviceOpenai = listModels({ provider: "openai", on_device_capable: true });
    expect(onDeviceOpenai.length).toBe(0);
  });

  it("listModels() returns a copy — mutating it does not affect the registry", () => {
    const a = listModels();
    a.pop();
    expect(listModels().length).toBe(MODEL_REGISTRY.models.length);
  });

  it("getModelPricing joins through pricing_ref into pricing.json", () => {
    const row = getModelPricing("gpt-4o");
    expect(row?.id).toBe("gpt-4o");
    expect(row?.input_per_1m).toBe(PRESET_PRICING.models.find((p) => p.id === "gpt-4o")!.input_per_1m);
  });

  it("getModelPricing is undefined for a local-only model (no pricing_ref) and unknown ids", () => {
    expect(getModelPricing("llama-3.2-1b")).toBeUndefined();
    expect(getModelPricing("nope")).toBeUndefined();
  });
});

describe("model registry: validation fails loud on malformed authored data", () => {
  it("wrong registry_version", () => {
    const r = validRegistry();
    (r as { registry_version: number }).registry_version = 99;
    expect(() => validateModelRegistry(r)).toThrow(LudionRegistryError);
  });

  it("empty models array", () => {
    const r = validRegistry();
    r.models = [];
    expect(() => validateModelRegistry(r)).toThrow(LudionRegistryError);
  });

  it("duplicate id", () => {
    const r = validRegistry();
    r.models.push({ ...r.models[0]! });
    expect(() => validateModelRegistry(r)).toThrow(/duplicate model id/);
  });

  it("bad kind", () => {
    const r = validRegistry();
    (r.models[0] as { kind: string }).kind = "edge";
    expect(() => validateModelRegistry(r)).toThrow(LudionRegistryError);
  });

  it("non-positive context_length", () => {
    const r = validRegistry();
    r.models[0]!.context_length = 0;
    expect(() => validateModelRegistry(r)).toThrow(/context_length/);
  });

  it("on_device_capable without webllm_model_id", () => {
    const r = validRegistry();
    delete (r.models[1] as Partial<ModelEntry>).webllm_model_id;
    expect(() => validateModelRegistry(r)).toThrow(/webllm_model_id/);
  });

  it("on_device_capable without params or memory hint", () => {
    const r = validRegistry();
    delete (r.models[1] as Partial<ModelEntry>).params;
    expect(() => validateModelRegistry(r)).toThrow(/params/);
  });

  it("webllm_model_id present on a non-on-device entry", () => {
    const r = validRegistry();
    (r.models[0] as ModelEntry).webllm_model_id = "X";
    expect(() => validateModelRegistry(r)).toThrow(/webllm_model_id/);
  });

  it("duplicate webllm_model_id across local entries", () => {
    const r = validRegistry();
    r.models.push({
      ...r.models[1]!,
      id: "llama-clone",
    });
    expect(() => validateModelRegistry(r)).toThrow(/duplicate webllm_model_id/);
  });

  it("pricing_ref that matches no pricing.json row", () => {
    const r = validRegistry();
    r.models[0]!.pricing_ref = "ghost-model";
    expect(() => validateModelRegistry(r)).toThrow(/matches no pricing.json row/);
  });

  it("api entry missing provider_model_id", () => {
    const r = validRegistry();
    delete (r.models[0] as Partial<ModelEntry>).provider_model_id;
    expect(() => validateModelRegistry(r)).toThrow(/provider_model_id/);
  });

  it("api entry missing the provider_model_id_verified flag", () => {
    const r = validRegistry();
    delete (r.models[0] as Partial<ModelEntry>).provider_model_id_verified;
    expect(() => validateModelRegistry(r)).toThrow(/provider_model_id_verified/);
  });
});
