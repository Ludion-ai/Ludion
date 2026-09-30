// Time budgets (spec §11.4, §11.6). The Gate may add at most `timeoutMs` to a request, whatever
// its dependencies do. Runtime-neutral: setTimeout and performance.now only.

/** A fault inside the Gate itself, not in the request. Only these follow fail_mode (ADR-020). */
export class GateFault extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) { super(message); this.name = "GateFault"; this.code = code; }
}

/**
 * Settle with `promise`, or reject with `onTimeout()` after `ms`. The losing promise keeps
 * running (a key fetch still fills the cache) and its rejection is handled by the race.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} onTimeout
 * @returns {Promise<T>}
 */
export function within(promise, ms, onTimeout) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), Math.max(0, ms)); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export const clock = () => performance.now();
