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
