// A tiny runtime-agnostic test shim for the portable suite (NEUT-1). node:test and node:assert
// are not on every runtime, so the suite registers with test() and checks with assert, and each
// host (Node, Deno, workerd) calls run() and reports the JSON result. No imports: the shim itself
// must load anywhere.

const registered = [];

/** @param {string} name @param {() => unknown | Promise<unknown>} fn */
export function test(name, fn) {
  if (registered.some((t) => t.name === name)) throw new Error(`duplicate test name: ${name}`);
  registered.push({ name, fn });
}

class AssertionError extends Error { constructor(message) { super(message); this.name = "AssertionError"; } }
const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
/** Canonical JSON (sorted keys) for deep equality of plain data. */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export const assert = {
  ok(v, msg) { if (!v) throw new AssertionError(msg ?? `expected truthy, got ${show(v)}`); },
  equal(a, b, msg) { if (!Object.is(a, b)) throw new AssertionError(`${msg ? `${msg}: ` : ""}expected ${show(b)}, got ${show(a)}`); },
  notEqual(a, b, msg) { if (Object.is(a, b)) throw new AssertionError(`${msg ? `${msg}: ` : ""}expected something other than ${show(b)}`); },
  deepEqual(a, b, msg) { if (canon(a) !== canon(b)) throw new AssertionError(`${msg ? `${msg}: ` : ""}expected ${canon(b)}, got ${canon(a)}`); },
  match(s, re, msg) { if (typeof s !== "string" || !re.test(s)) throw new AssertionError(`${msg ? `${msg}: ` : ""}expected ${show(s)} to match ${re}`); },
  async rejects(fnOrPromise, re, msg) {
    try { await (typeof fnOrPromise === "function" ? fnOrPromise() : fnOrPromise); }
    catch (e) { if (re && !re.test(String(e?.message ?? e))) throw new AssertionError(`${msg ? `${msg}: ` : ""}rejected with ${show(String(e?.message ?? e))}, expected ${re}`); return; }
    throw new AssertionError(`${msg ? `${msg}: ` : ""}expected a rejection`);
  },
};

/**
 * Run every registered test, sequentially, in registration order.
 * @param {{ runtime: string }} host
 * @returns {Promise<{ runtime: string, total: number, passed: number, failed: number, tests: { name: string, ok: boolean, error?: string }[] }>}
 */
export async function run({ runtime }) {
  const tests = [];
  for (const t of registered) {
    try { await t.fn(); tests.push({ name: t.name, ok: true }); }
    catch (e) { tests.push({ name: t.name, ok: false, error: String(e?.stack ?? e?.message ?? e).slice(0, 800) }); }
  }
  const passed = tests.filter((t) => t.ok).length;
  return { runtime, total: tests.length, passed, failed: tests.length - passed, tests };
}

/** For the node:test wrapper: the registered tests themselves. */
export const registeredTests = () => registered.slice();
