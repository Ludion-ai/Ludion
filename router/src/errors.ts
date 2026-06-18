/** Typed router errors (spec Section 5/6, decisions A-2 / B-2). */

/**
 * privacy:true and no local path exists on this hardware class (R1/R2/R3
 * class), or the local model is struck (B-2: forcing local on a device with
 * kill history would kill the customer's tab). Never silently sent to server.
 */
export class LudionPrivacyUnroutable extends Error {
  override name = "LudionPrivacyUnroutable";
  constructor(
    public readonly rule_id: string,
    reason: string,
  ) {
    super(`privacy:true is unroutable (${rule_id}): ${reason}`);
  }
}

/**
 * Local streaming generation failed AFTER the first content token was
 * yielded. Yielded tokens cannot be recalled, so transparent server retry is
 * impossible by principle (A-2); the stream terminates with this typed error
 * and the decision log records `degraded_failed`.
 */
export class LudionMidStreamError extends Error {
  override name = "LudionMidStreamError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The policy routed this request to the server (or degraded to it), but
 * `Ludion.create()` was called without a `fallback` endpoint (Phase 0:
 * zero-config local-only mode). Carries the rule that decided the route so
 * the caller can see *why* the server was needed. Fix: pass
 * `fallback: { url, model }` pointing at your own OpenAI-compatible relay
 * proxy (see docs/recipes/) — never ship an API key in client code.
 */
export class LudionNoFallbackConfigured extends Error {
  override name = "LudionNoFallbackConfigured";
  constructor(public readonly rule_id: string) {
    super(
      `request routed to server (${rule_id}) but no fallback endpoint is configured; ` +
        `pass fallback: { url, model } to Ludion.create() (key belongs in a server-side proxy, not the client)`,
    );
  }
}

/**
 * Drop-in (Spec A) externally-supplied config failed validation: a config
 * object handed to `setDropinConfig()` (or supplied by a future Spec B config
 * source) is malformed or carries an unsupported `config_version`. Thrown at
 * the injection boundary so a bad UI/remote config surfaces a typed error
 * instead of silently routing wrong. Never carries a key or any secret value.
 */
export class LudionConfigError extends Error {
  override name = "LudionConfigError";
  constructor(message: string) {
    super(`invalid Ludion drop-in config: ${message}`);
  }
}

/**
 * Spec C: the bundled model registry (registry.json) failed validation at load
 * — a malformed, duplicated, or out-of-version entry, or a `pricing_ref` that
 * names no row in pricing.json. The registry is authored data, so a bad entry
 * is a build/author error: it fails LOUD at module load rather than silently
 * resolving a wrong model later. Never carries a key or any secret value.
 */
export class LudionRegistryError extends Error {
  override name = "LudionRegistryError";
  constructor(message: string) {
    super(`invalid Ludion model registry: ${message}`);
  }
}

/**
 * Drop-in (Spec A.1): the caller passed a `chat.completions.create` param the
 * router cannot honor faithfully (e.g. `tools`, `response_format`). Thrown
 * BEFORE any inference runs so the request never appears to succeed while
 * silently dropping correctness-affecting input. Silent omission is the same
 * sin as over-claiming a number: if Ludion cannot honor an input it says so
 * loudly. Names the exact unsupported param(s); carries no content.
 */
export class LudionUnsupportedParamError extends Error {
  override name = "LudionUnsupportedParamError";
  constructor(public readonly params: readonly string[]) {
    const list = params.map((p) => `'${p}'`).join(", ");
    super(
      `ludion drop-in does not yet support ${list}. ` +
        `supported params: messages, model, stream, temperature, max_tokens. ` +
        `track support at https://github.com/Ludion-ai/Ludion/issues`,
    );
  }
}

/**
 * B-3: context-window-overflow errors are an input property, not a device
 * defect — they degrade to server but do NOT add a strike. Matched by error
 * name whitelist (WebLLM 0.2.84 error classes don't always set `.name`, so
 * the constructor name is checked too).
 */
const NO_STRIKE_ERROR_NAMES: ReadonlySet<string> = new Set(["ContextWindowSizeExceededError"]);

export function isContextOverflowError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return NO_STRIKE_ERROR_NAMES.has(e.name) || NO_STRIKE_ERROR_NAMES.has(e.constructor.name);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.constructor.name !== "Error" ? e.constructor.name : e.name}: ${e.message}`;
  return String(e);
}
