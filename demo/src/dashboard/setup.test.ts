import { describe, expect, it } from "vitest";
import { validateStoredConfig } from "ludion-workspace/schema";
import type { StoredConfig } from "ludion-workspace/schema";
import {
  assembleDropinConfig,
  fallbackModels,
  generateRelayToken,
  relayBaseUrl,
  relayDeployed,
  toStoredPayload,
  upstreamFor,
  wranglerVars,
} from "./setup";

describe("fallbackModels — registry partition", () => {
  it("separates verified api, unverified api, and local models", () => {
    const { selectable, unverified, local } = fallbackModels();
    // Verified api models are selectable; gemini (verified:false) is withheld.
    expect(selectable.map((m) => m.id)).toContain("gpt-4o-mini");
    expect(selectable.every((m) => m.kind === "api" && m.provider_model_id_verified === true)).toBe(true);
    expect(unverified.map((m) => m.id)).toContain("gemini-flash");
    expect(selectable.map((m) => m.id)).not.toContain("gemini-flash");
    // Local models are the on-device tier, never in the fallback picker.
    expect(local.every((m) => m.kind === "local")).toBe(true);
    expect(local.map((m) => m.id)).toContain("llama-3.2-1b");
  });
});

describe("upstreamFor — provider → OpenAI-compatible upstream", () => {
  it("returns OpenAI's verified base for openai models", () => {
    const m = fallbackModels().selectable.find((x) => x.provider === "openai");
    expect(upstreamFor(m)).toEqual({ url: "https://api.openai.com/v1", verified: true });
  });
  it("marks anthropic's upstream unverified (a paste-point default)", () => {
    const m = fallbackModels().selectable.find((x) => x.provider === "anthropic");
    expect(upstreamFor(m)?.verified).toBe(false);
  });
  it("is null for an unknown provider or no model", () => {
    expect(upstreamFor(undefined)).toBeNull();
  });
});

describe("relay status helpers", () => {
  it("relayDeployed reflects a recorded relayUrl", () => {
    expect(relayDeployed(null)).toBe(false);
    expect(relayDeployed({ config_version: 1, fallback: {} })).toBe(false);
    expect(relayDeployed({ config_version: 1, fallback: {}, relayUrl: "https://r.workers.dev" })).toBe(true);
  });
  it("relayBaseUrl prefers relayUrl, falls back to stored baseURL", () => {
    expect(relayBaseUrl({ config_version: 1, fallback: { baseURL: "https://b.dev" } })).toBe("https://b.dev");
    expect(
      relayBaseUrl({ config_version: 1, fallback: { baseURL: "https://b.dev" }, relayUrl: "https://r.dev" }),
    ).toBe("https://r.dev");
  });
});

describe("assembleDropinConfig — client config carries the token client-side", () => {
  it("adds the relay token as fallback.apiKey alongside server fields", () => {
    const stored: StoredConfig = {
      config_version: 1,
      fallback: { model: "gpt-4o-mini" },
      relayUrl: "https://r.workers.dev",
    };
    const cfg = assembleDropinConfig(stored, "tok_abc");
    expect(cfg.fallback).toEqual({ baseURL: "https://r.workers.dev", model: "gpt-4o-mini", apiKey: "tok_abc" });
  });
  it("omits apiKey when there is no token", () => {
    const cfg = assembleDropinConfig({ config_version: 1, fallback: { model: "gpt-4o" } }, null);
    expect(cfg.fallback?.apiKey).toBeUndefined();
    expect(cfg.fallback?.model).toBe("gpt-4o");
  });
});

describe("toStoredPayload — §5 token never goes server-ward", () => {
  it("produces only non-secret fields the server schema accepts", () => {
    const payload = toStoredPayload({ config_version: 1, fallback: {} }, {
      model: "gpt-4o-mini",
      relayUrl: "https://r.workers.dev",
      baseURL: "https://r.workers.dev",
    });
    // The exact shape the server stores — round-trips through 2a validation.
    expect(validateStoredConfig(payload)).toEqual(payload);
    // No secret/token-shaped key anywhere in the wire payload.
    expect(JSON.stringify(payload).toLowerCase()).not.toMatch(/key|token|secret|apikey/);
  });
  it("preserves prior fields when patching a single field", () => {
    const prev: StoredConfig = { config_version: 1, fallback: { model: "gpt-4o" }, relayUrl: "https://old.dev" };
    expect(toStoredPayload(prev, { relayUrl: "https://new.dev", baseURL: "https://new.dev" })).toEqual({
      config_version: 1,
      fallback: { model: "gpt-4o", baseURL: "https://new.dev" },
      relayUrl: "https://new.dev",
    });
  });
});

describe("wranglerVars + generateRelayToken", () => {
  it("fills the [vars] block with upstream + origin", () => {
    const vars = wranglerVars("https://api.openai.com/v1", "https://app.example");
    expect(vars).toContain('UPSTREAM_BASE_URL = "https://api.openai.com/v1"');
    expect(vars).toContain('ALLOWED_ORIGINS = "https://app.example"');
  });
  it("generates a 64-char hex token", () => {
    const t = generateRelayToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(generateRelayToken()).not.toBe(t);
  });
});
