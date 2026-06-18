/**
 * Drop-in plumbing (Spec A) — the entry + injection seam that lets existing
 * SDK-shaped code run through the Ludion router by changing one import line.
 *
 * This module is SDK-agnostic. It owns three things:
 *   1. the adapter SEAM (`SdkAdapter`) — adapter #1 is OpenAI (see openai.ts);
 *      a future Anthropic/VercelAI adapter slots in here WITHOUT touching the
 *      decision core (policy.ts) or the executors (local.ts / server.ts),
 *   2. the external CONFIG injection point (`ConfigSource` + the in-memory
 *      default + `setDropinConfig` / `getDropinConfig`) that Spec B's UI will
 *      back with localStorage/remote — no storage or UI is built here,
 *   3. `resolveLudion()` — memoizes `Ludion.create()` per resolved config so a
 *      per-request call never re-probes the device (or re-pops a WebGPU adapter
 *      request) on every message.
 *
 * KEY CUSTODY: an apiKey supplied here is placed ONLY on `FallbackConfig` and
 * is forwarded by server.ts as an `Authorization: Bearer` header to the
 * developer's own endpoint. It is never stored, never logged, and the
 * in-memory config source below holds it only for the lifetime of the page.
 */
import type { FallbackConfig, LudionOptions } from "./types";
import type { PolicyTable } from "./policy";
import { Ludion } from "./index";
import type { LudionChatRequest, LudionCompletionResponse, LudionStreamResponse } from "./index";
import { LudionConfigError } from "./errors";

/** Bump when the externally-supplied config shape changes incompatibly. */
export const DROPIN_CONFIG_VERSION = 1;

/**
 * Externally-injectable config (Spec A #3). Drives the fallback target and
 * (optionally) the policy from OUTSIDE `create()`. Spec B's UI writes this;
 * for now it is set in code via `setDropinConfig()`.
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
 * The injection interface Spec B implements (localStorage/remote-backed).
 * Synchronous + nullable so a missing config is just "use defaults".
 */
export interface ConfigSource {
  get(): LudionDropinConfig | null;
}

/** In-memory default config source — no persistence (Spec B replaces this). */
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
 * Validate then install an externally-supplied config (code-level for now;
 * Spec B's UI calls this). Throws `LudionConfigError` on a malformed object.
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
 * source). The seam Spec B's UI plugs into without rearchitecting the router.
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
  if (
    cfg.config_version !== undefined &&
    cfg.config_version !== DROPIN_CONFIG_VERSION
  ) {
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

/**
 * The ADAPTER SEAM. One interface; OpenAI is adapter #1 (openai.ts). A second
 * SDK is a new file implementing this — the router core never changes.
 *
 *   request-shape-in  → `toLudionRequest`
 *   router call       → `resolveLudion` + `ludion.chat.completions.create`
 *   response-shape-out → `fromCompletion` / `fromStream`
 *
 * Because the router already emits the OpenAI response shape, OpenAI's
 * response hooks are identity. A future AnthropicAdapter supplies real
 * reshaping there (and must re-attach `_ludion`).
 *
 * @typeParam Req  the SDK's request object (e.g. OpenAI ChatCompletionCreateParams)
 * @typeParam Comp the SDK's non-stream response
 * @typeParam Strm the SDK's streamed response
 */
export interface SdkAdapter<Req, Comp, Strm> {
  /** SDK request → router request + the caller's model (used as the fallback target). */
  toLudionRequest(req: Req): { ludion: LudionChatRequestLike; model: string | undefined };
  /** Router (OpenAI-shaped) completion → this SDK's completion. Must preserve `_ludion`. */
  fromCompletion(res: LudionCompletionLike): Comp;
  /** Router (OpenAI-shaped) stream → this SDK's stream. Must preserve `_ludion`. */
  fromStream(res: LudionStreamLike): Strm;
}

// Structural aliases so adapter files reference the router shapes by intent.
export type LudionChatRequestLike = LudionChatRequest;
export type LudionCompletionLike = LudionCompletionResponse;
export type LudionStreamLike = LudionStreamResponse;

/** Resolved fallback + policy, derived from client options ∪ injected config. */
export interface ResolvedRouting {
  fallback: FallbackConfig | undefined;
  policy: PolicyTable | undefined;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Merge SDK-client constructor options (highest precedence for the fields they
 * carry) with the injected config (defaults), and the per-request model, into
 * the router's `FallbackConfig`. A request with no resolvable fallback model
 * yields `fallback: undefined` → the router runs local-only and throws
 * `LudionNoFallbackConfigured` if a server route is needed.
 */
export function resolveRouting(
  client: { apiKey?: string; baseURL?: string },
  requestModel: string | undefined,
): ResolvedRouting {
  const injected = getDropinConfig();
  const baseURL = client.baseURL ?? injected?.fallback?.baseURL ?? DEFAULT_BASE_URL;
  const apiKey = client.apiKey ?? injected?.fallback?.apiKey;
  const model = requestModel ?? injected?.fallback?.model;
  const policy = injected?.policy;

  if (model === undefined) {
    return { fallback: undefined, policy };
  }
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const fallback: FallbackConfig = apiKey !== undefined ? { url, apiKey, model } : { url, model };
  return { fallback, policy };
}

// Memoize Ludion per resolved config so per-request calls don't re-probe the
// device. apiKey participates in the key (in-memory Map only; never logged) so
// a key rotation produces a fresh instance.
const ludionCache = new Map<string, Promise<Ludion>>();

function cacheKey(routing: ResolvedRouting): string {
  const f = routing.fallback;
  return JSON.stringify([
    f?.url ?? null,
    f?.model ?? null,
    f && "apiKey" in f ? (f.apiKey ?? "") : null,
    routing.policy?.policy_version ?? null,
  ]);
}

/**
 * Get-or-create a `Ludion` for this routing. `test` carries internal test
 * hooks only (probe/executor injection) — never part of any SDK surface. The
 * per-request decision is read off the response's `_ludion` field, so no
 * `onDecision` callback is baked into the cached instance.
 */
export function resolveLudion(
  routing: ResolvedRouting,
  test?: LudionOptions["_test"],
): Promise<Ludion> {
  // Test instances (with injected hooks) bypass the cache so distinct hooks
  // never collide across calls.
  if (test !== undefined) {
    return Ludion.create({
      ...(routing.fallback ? { fallback: routing.fallback } : {}),
      ...(routing.policy ? { policy: routing.policy } : {}),
      _test: test,
    });
  }
  const key = cacheKey(routing);
  let inst = ludionCache.get(key);
  if (inst === undefined) {
    inst = Ludion.create({
      ...(routing.fallback ? { fallback: routing.fallback } : {}),
      ...(routing.policy ? { policy: routing.policy } : {}),
    });
    ludionCache.set(key, inst);
  }
  return inst;
}

/** Test-only: drop the memoized instances (keeps unit tests independent). */
export function _resetDropinCache(): void {
  ludionCache.clear();
}
