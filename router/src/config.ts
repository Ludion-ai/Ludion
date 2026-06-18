/**
 * Config seam (Spec A core + Spec B step 1 persistence) — the SDK-agnostic,
 * dependency-LEAF module that owns externally-injectable router config.
 *
 * It imports only leaf modules (types, policy types, errors) and NEVER imports
 * `index.ts`, so both the facade (`index.ts`) and the drop-in plumbing
 * (`dropin.ts`) can read config from here without a circular import. `dropin.ts`
 * re-exports these names for API stability (Spec A's public surface).
 *
 * Spec B step 1 adds a per-request read-point and a browser-storage-backed
 * `ConfigSource` so a setting changed in the UI is honored by the NEXT
 * inference request with no `location.reload()`.
 *
 * KEY CUSTODY: an apiKey placed on a config here is forwarded by `server.ts`
 * ONLY as an `Authorization: Bearer` header to the developer's own `baseURL`.
 * Ludion never logs it. The in-memory default source below holds it only for
 * the page lifetime. The OPTIONAL storage source persists it on the app's own
 * origin (see `createStorageConfigSource` for the honest tradeoff).
 */
import type { FallbackConfig } from "./types";
import type { PolicyTable } from "./policy";
import { LudionConfigError, errorMessage } from "./errors";

/** Bump when the externally-supplied config shape changes incompatibly. */
export const DROPIN_CONFIG_VERSION = 1;

/**
 * Externally-injectable config (Spec A #3). Drives the fallback target and
 * (optionally) the policy from OUTSIDE `create()`. Spec B's UI writes this.
 */
export interface LudionDropinConfig {
  /** Schema version; must equal DROPIN_CONFIG_VERSION (absent → assumed current). */
  config_version?: number;
  /** Where to degrade to, and the key custody for it. */
  fallback?: {
    /** OpenAI-style base URL, e.g. "https://api.openai.com/v1". "/chat/completions" is appended. */
    baseURL?: string;
    /** Default fallback model when a request omits one. */
    model?: string;
    /** Stays client-side; forwarded only to `baseURL` as a Bearer header. Never persisted by Ludion. */
    apiKey?: string;
  };
  /** Optional routing policy override (validated minimally). */
  policy?: PolicyTable;
}

/**
 * The injection interface Spec B implements (in-memory / storage / remote).
 * Synchronous + nullable so a missing config is just "use defaults", and so the
 * facade can read it on every request with no async cost.
 */
export interface ConfigSource {
  get(): LudionDropinConfig | null;
}

/** In-memory default config source — no persistence. */
class InMemoryConfigSource implements ConfigSource {
  private current: LudionDropinConfig | null = null;
  get(): LudionDropinConfig | null {
    return this.current;
  }
  set(config: LudionDropinConfig | null): void {
    this.current = config;
  }
}

const defaultSource = new InMemoryConfigSource();
let activeSource: ConfigSource = defaultSource;

/**
 * Validate then install an externally-supplied config into the in-memory
 * default source. Throws `LudionConfigError` on a malformed object.
 */
export function setDropinConfig(config: LudionDropinConfig | null): void {
  defaultSource.set(config === null ? null : validateDropinConfig(config));
  activeSource = defaultSource;
}

/** Read the active config (null = none injected → built-in defaults apply). */
export function getDropinConfig(): LudionDropinConfig | null {
  return activeSource.get();
}

/**
 * Replace the config source entirely (Spec B: a localStorage/remote-backed
 * source). The facade reads `getDropinConfig()` per request, so a source whose
 * `get()` reads live storage makes a UI change take effect on the next request.
 */
export function setConfigSource(source: ConfigSource): void {
  activeSource = source;
}

/**
 * Minimal structural validation (Spec A #3 "keep it minimal"). Confirms the
 * version is supported and the present fields are well-typed. Does NOT inspect
 * or transmit the apiKey.
 */
export function validateDropinConfig(input: unknown): LudionDropinConfig {
  if (input === null || typeof input !== "object") {
    throw new LudionConfigError("config must be an object");
  }
  const cfg = input as Record<string, unknown>;
  if (cfg.config_version !== undefined && cfg.config_version !== DROPIN_CONFIG_VERSION) {
    throw new LudionConfigError(
      `unsupported config_version ${String(cfg.config_version)} (this build supports ${DROPIN_CONFIG_VERSION})`,
    );
  }
  if (cfg.fallback !== undefined) {
    if (typeof cfg.fallback !== "object" || cfg.fallback === null) {
      throw new LudionConfigError("fallback must be an object");
    }
    const fb = cfg.fallback as Record<string, unknown>;
    for (const key of ["baseURL", "model", "apiKey"] as const) {
      if (fb[key] !== undefined && typeof fb[key] !== "string") {
        throw new LudionConfigError(`fallback.${key} must be a string`);
      }
    }
  }
  if (cfg.policy !== undefined) {
    const p = cfg.policy as Record<string, unknown>;
    if (
      typeof p !== "object" ||
      p === null ||
      typeof p.policy_version !== "string" ||
      !Array.isArray(p.rules)
    ) {
      throw new LudionConfigError("policy must be a PolicyTable (policy_version: string, rules: array)");
    }
  }
  return input as LudionDropinConfig;
}

/** Default OpenAI-compatible base URL when a config supplies a model but no baseURL. */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** OpenAI-style baseURL → the full `/chat/completions` URL the executors fetch. */
export function toChatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

// --- Spec B step 1: optional browser-storage-backed config source -----------

/** Default localStorage key for the persisted drop-in config. */
export const DEFAULT_CONFIG_STORAGE_KEY = "ludion.config.v1";

/** Just the slice of the `Storage` API the source needs (injectable for tests). */
export type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface StorageConfigSourceOptions {
  /** Defaults to `globalThis.localStorage`. Pass `sessionStorage` or a stub to change persistence. */
  storage?: ConfigStorage;
  /** Defaults to `DEFAULT_CONFIG_STORAGE_KEY`. */
  key?: string;
}

function resolveStorage(opts: StorageConfigSourceOptions): ConfigStorage | null {
  if (opts.storage) return opts.storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null; // storage access can throw (sandboxed/blocked origins)
  }
}

/**
 * A `ConfigSource` backed by browser storage under a versioned key. `get()`
 * reads + validates on every call, so it is always live for the facade's
 * per-request read. Bad/old/corrupt stored config falls back to defaults
 * silently-safe (returns null) but warns once (re-armed by the next good read),
 * per the no-silent-failure principle.
 *
 * HONEST TRADEOFF: with the default `localStorage`, a persisted apiKey is
 * readable by any script on the app's origin (XSS-exfiltratable). This is a
 * developer convenience for a dev tool, NOT end-user secret storage. Real
 * secrets belong behind a server-side relay so the key never reaches the
 * browser. Pass `{ storage: sessionStorage }` for per-tab, or keep the
 * in-memory default (`setDropinConfig`) for no persistence at all.
 */
export function createStorageConfigSource(opts: StorageConfigSourceOptions = {}): ConfigSource {
  const key = opts.key ?? DEFAULT_CONFIG_STORAGE_KEY;
  let warned = false;
  return {
    get(): LudionDropinConfig | null {
      const storage = resolveStorage(opts);
      if (storage === null) return null;
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return null;
      }
      if (raw === null || raw === "") return null;
      try {
        const config = validateDropinConfig(JSON.parse(raw));
        warned = false; // a good read re-arms the one-shot warning
        return config;
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn(
            `ludion: ignoring invalid stored config at "${key}" (using defaults): ${errorMessage(e)}`,
          );
        }
        return null;
      }
    },
  };
}

/**
 * Validate + persist a drop-in config to browser storage (Spec B's UI calls
 * this on save). Passing `null` clears the stored config. Throws
 * `LudionConfigError` BEFORE writing if the config is malformed, so a bad UI
 * value never persists.
 */
export function writeDropinConfig(
  config: LudionDropinConfig | null,
  opts: StorageConfigSourceOptions = {},
): void {
  const key = opts.key ?? DEFAULT_CONFIG_STORAGE_KEY;
  const validated = config === null ? null : validateDropinConfig(config);
  const storage = resolveStorage(opts);
  if (storage === null) throw new LudionConfigError("no browser storage available to persist config");
  if (validated === null) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(validated));
}

/**
 * Resolve the effective `FallbackConfig` for a request: `create()`-time config
 * wins per field, the live injected config fills the rest (Spec B precedence).
 * Returns `undefined` when no model is resolvable (→ local-only / typed
 * `LudionNoFallbackConfigured` on a server route).
 */
export function resolveEffectiveFallback(
  base: FallbackConfig | undefined,
): FallbackConfig | undefined {
  const live = getDropinConfig()?.fallback;
  const model = base?.model ?? live?.model;
  if (model === undefined) return undefined;
  const apiKey = base?.apiKey ?? live?.apiKey;
  const url = base?.url ?? toChatCompletionsUrl(live?.baseURL ?? DEFAULT_BASE_URL);
  return apiKey !== undefined ? { url, apiKey, model } : { url, model };
}
