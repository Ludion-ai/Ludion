/**
 * Stored config schema + validation — Workspace 2a.
 *
 * STORAGE INVARIANT (hard rule, §1): the server stores ONLY non-secret config.
 * This schema has no field capable of holding a provider key, a relay token, or
 * any prompt/output content. Validation enforces it two ways:
 *   1. an allow-list — any unknown field is rejected (fail loud, 400);
 *   2. a recursive forbidden-key scan — any key whose name looks like a secret
 *      or message content is rejected even if it somehow matched the allow-list.
 *
 * DIVERGENCE from the client `ludion.config.v1` (router/src/config.ts): the
 * client config also carries `fallback.apiKey` (the relay token), which stays in
 * the browser's localStorage and is NEVER sent to a Ludion endpoint. The stored
 * shape below deliberately omits it. 2b's UI maps stored config → client config
 * by adding the token client-side; the token never travels server-ward.
 */

/** Bump when the stored shape changes incompatibly. */
export const STORED_CONFIG_VERSION = 1;

/** Non-secret fallback target. No apiKey/token — those live client-side only. */
export interface StoredFallback {
  /** OpenAI-style base URL of the relay, e.g. "https://relay.example.workers.dev". */
  baseURL?: string;
  /** Selected fallback model id, e.g. "gpt-4o-mini". */
  model?: string;
}

/**
 * One user's stored, non-secret config. `policy` is intentionally absent in 2a
 * (the policy-editing UI is 2b); when added it will be a non-secret PolicyTable.
 */
export interface StoredConfig {
  config_version: number;
  fallback: StoredFallback;
  /** Deployed relay URL the developer pasted (non-secret). */
  relayUrl?: string;
  /** Project id for opt-in central decision telemetry (non-secret, no content). */
  projectId?: string;
}

export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConfigError";
  }
}

const TOP_LEVEL_KEYS = new Set(["config_version", "fallback", "relayUrl", "projectId"]);
const FALLBACK_KEYS = new Set(["baseURL", "model"]);

/**
 * Names that must never appear anywhere in a stored config. Catches a secret or
 * content field even if a future edit widens the allow-list by mistake.
 */
const FORBIDDEN_KEY = /key|token|secret|password|prompt|message|content|completion|authorization/i;

/** The empty default returned for a user with nothing stored yet. */
export function emptyStoredConfig(): StoredConfig {
  return { config_version: STORED_CONFIG_VERSION, fallback: {} };
}

function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    // Stored config has no arrays in 2a; an array is itself unexpected shape.
    throw new WorkspaceConfigError(`unexpected array at "${path || "(root)"}"`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(k)) {
      throw new WorkspaceConfigError(
        `stored config must not contain secrets or content: field "${path ? `${path}.` : ""}${k}" is forbidden`,
      );
    }
    assertNoForbiddenKeys(v, path ? `${path}.${k}` : k);
  }
}

function isValidHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "https:" || u.protocol === "http:";
}

/**
 * Validate an untrusted PUT payload into a StoredConfig. Throws
 * `WorkspaceConfigError` on any violation BEFORE anything is stored. The
 * forbidden-key scan runs first so a secret-bearing payload fails with a precise
 * message rather than a generic "unknown field".
 */
export function validateStoredConfig(input: unknown): StoredConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceConfigError("config must be an object");
  }

  // Hard invariant first: no secret/content-shaped key anywhere.
  assertNoForbiddenKeys(input, "");

  const cfg = input as Record<string, unknown>;
  for (const k of Object.keys(cfg)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      throw new WorkspaceConfigError(`unknown field "${k}" (stored config holds only non-secret routing config)`);
    }
  }

  if (cfg.config_version !== undefined && cfg.config_version !== STORED_CONFIG_VERSION) {
    throw new WorkspaceConfigError(
      `unsupported config_version ${String(cfg.config_version)} (this build supports ${STORED_CONFIG_VERSION})`,
    );
  }

  const out: StoredConfig = emptyStoredConfig();

  if (cfg.fallback !== undefined) {
    if (typeof cfg.fallback !== "object" || cfg.fallback === null || Array.isArray(cfg.fallback)) {
      throw new WorkspaceConfigError("fallback must be an object");
    }
    const fb = cfg.fallback as Record<string, unknown>;
    for (const k of Object.keys(fb)) {
      if (!FALLBACK_KEYS.has(k)) {
        throw new WorkspaceConfigError(`unknown fallback field "${k}"`);
      }
    }
    if (fb.baseURL !== undefined) {
      if (typeof fb.baseURL !== "string") throw new WorkspaceConfigError("fallback.baseURL must be a string");
      if (!isValidHttpUrl(fb.baseURL)) throw new WorkspaceConfigError("fallback.baseURL must be an http(s) URL");
      out.fallback.baseURL = fb.baseURL;
    }
    if (fb.model !== undefined) {
      if (typeof fb.model !== "string") throw new WorkspaceConfigError("fallback.model must be a string");
      out.fallback.model = fb.model;
    }
  }

  if (cfg.relayUrl !== undefined) {
    if (typeof cfg.relayUrl !== "string") throw new WorkspaceConfigError("relayUrl must be a string");
    if (!isValidHttpUrl(cfg.relayUrl)) throw new WorkspaceConfigError("relayUrl must be an http(s) URL");
    out.relayUrl = cfg.relayUrl;
  }

  if (cfg.projectId !== undefined) {
    if (typeof cfg.projectId !== "string") throw new WorkspaceConfigError("projectId must be a string");
    out.projectId = cfg.projectId;
  }

  return out;
}
