/**
 * Drop-in plumbing (Spec A) — the entry + injection seam that lets existing
 * SDK-shaped code run through the Ludion router by changing one import line.
 *
 * This module is SDK-agnostic. It owns two things:
 *   1. the adapter SEAM (`SdkAdapter`) — adapter #1 is OpenAI (see openai.ts);
 *      a future Anthropic/VercelAI adapter slots in here WITHOUT touching the
 *      decision core (policy.ts) or the executors (local.ts / server.ts),
 *   2. `resolveLudion()` — memoizes `Ludion.create()` per resolved config so a
 *      per-request call never re-probes the device (or re-pops a WebGPU adapter
 *      request) on every message.
 *
 * The CONFIG injection seam (`ConfigSource` + `setDropinConfig` /
 * `getDropinConfig` / `setConfigSource` + validation + the storage source)
 * lives in the dependency-leaf `config.ts` so the facade (`index.ts`) can read
 * it per request without a circular import. It is re-exported below so Spec A's
 * public drop-in surface is unchanged.
 *
 * KEY CUSTODY: an apiKey supplied here is placed ONLY on `FallbackConfig` and
 * is forwarded by server.ts as an `Authorization: Bearer` header to the
 * developer's own endpoint. It is never stored or logged by this module.
 */
import type { FallbackConfig, LudionOptions } from "./types";
import type { PolicyTable } from "./policy";
import { Ludion } from "./index";
import type { LudionChatRequest, LudionCompletionResponse, LudionStreamResponse } from "./index";
import {
  DEFAULT_BASE_URL,
  getDropinConfig,
  toChatCompletionsUrl,
} from "./config";

// Re-export the config seam from its leaf home so the drop-in public surface
// (Spec A) is stable: `import { setDropinConfig, ... } from "ludion-router/openai"`.
export type {
  LudionDropinConfig,
  ConfigSource,
  ConfigStorage,
  StorageConfigSourceOptions,
} from "./config";
export {
  DROPIN_CONFIG_VERSION,
  DEFAULT_CONFIG_STORAGE_KEY,
  setDropinConfig,
  getDropinConfig,
  setConfigSource,
  validateDropinConfig,
  createStorageConfigSource,
  writeDropinConfig,
} from "./config";

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
  const url = toChatCompletionsUrl(baseURL);
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
