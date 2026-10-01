// @ludion/gate-workers — the Ludion Gate around a Cloudflare Workers fetch handler. The install
// (ADR-022): wrap the default export, and put the site config in wrangler.toml:
//
//   import { withLudion } from "@ludion/gate-workers";
//   export default withLudion({
//     async fetch(request, env, ctx) { … },
//   });
//
//   # wrangler.toml
//   compatibility_flags = ["nodejs_compat"]
//   [vars.LUDION]
//   site_id = "site-7f3a"
//   pressure = 0
//
// The receipt key comes from the LUDION_SITE_KEY secret (`wrangler secret put LUDION_SITE_KEY`).
// It runs in the customer's own account, so neutrality holds (spec §11.2).
import { createGate, bodyNeeded, readWebBody } from "@ludion/gate-core";
import { gateConfig } from "@ludion/gate-core/config";

/** The Gate's result for each request the wrapped handler is serving. */
const results = new WeakMap();

/**
 * The Gate's result for the request your handler received (null if the Gate did not see it, or is
 * disabled). Where the handler knows the total of a payment made on someone's behalf:
 *
 *   const v = await ludion(request)?.charge({ amount, currency });   // integer, the currency's minor unit
 *   if (v && !v.ok) return new Response(JSON.stringify({ error: v.error }), { status: v.status, headers: v.headers });
 *
 * charge() holds it to the agent's Mandate (spec §10.6) where the route asks for one; never on humans.
 * @param {Request} request the very Request object the handler was given
 */
export function ludion(request) {
  return results.get(request) ?? null;
}

/** Web Request → RFC 9421 RequestDescriptor. */
function describe(request) {
  const fields = [];
  request.headers.forEach((value, name) => { fields.push({ name, value }); });
  return { kind: "request", method: request.method, targetUri: request.url, fields };
}

/** Add the Gate's headers without touching status, body or the app's own headers. */
function withHeaders(response, headers) {
  if (response.webSocket || response.status === 101) return response; // an upgrade is passed through untouched
  try {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  } catch { // headers of a Response from fetch() are immutable: copy the envelope, keep the body stream
    const copy = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}

/**
 * @template {{ fetch: Function }} H
 * @param {H} handler                  the Worker's default export
 * @param {{ configVar?: string, onError?: (e: unknown) => void, mandateLedger?: { shared: true, charge: Function } }} [options]
 *        mandateLedger: where the site counts each Mandate's per_day, ONE record for all its isolates and
 *        Gates (e.g. backed by a Durable Object or a database); without one a Mandate with per_day is
 *        refused at charge() (PRS-3). Isolates share no memory, so the file config cannot name one.
 * @returns {H}
 */
export function withLudion(handler, { configVar = "LUDION", onError = defaultOnError, mandateLedger } = {}) {
  let ready;
  const pending = [];
  // The sink is never awaited by the Gate; each delivery is handed to ctx.waitUntil so the
  // runtime does not cancel it when the response is returned.
  const trackedFetch = (...args) => { const p = fetch(...args); pending.push(p); return p; };
  const init = async (env) => {
    const spec = env?.[configVar];
    const config = await gateConfig(spec, { siteKey: env?.LUDION_SITE_KEY, fetch: trackedFetch });
    if (config.mandateLedger || config.mandateLedgerFile) throw new TypeError("mandate_ledger: a Worker runs in many isolates that share no memory or file; pass a shared ledger in code: withLudion(handler, { mandateLedger })");
    const { mandateLedgerFile, ...rest } = config;
    return createGate({ ...rest, ...(mandateLedger ? { mandateLedger } : {}) });
  };

  return {
    ...handler,
    async fetch(request, env, ctx) {
      let gate;
      try { gate = await (ready ??= init(env)); }
      catch (e) { ready = Promise.reject(e); ready.catch(() => {}); onError(e); return handler.fetch.call(this ?? handler, request, env, ctx); } // never take the site down
      const desc = describe(request);
      // Only a signature that covers content-digest makes the Gate read the body: a clone, to check it (GATE-11).
      if (bodyNeeded(desc)) desc.body = await readWebBody(request);
      const result = await gate.inspect(desc, { ip: request.headers.get("cf-connecting-ip") ?? undefined, country: request.cf?.country });
      result.charge = (c) => gate.charge(result, c);
      results.set(request, result);
      if (pending.length) ctx?.waitUntil?.(Promise.allSettled(pending.splice(0)));
      if (result.decision.action === "deny") {
        return new Response(JSON.stringify({ error: result.decision.error, help: `https://ludion.ai/e/${result.decision.error}` }),
          { status: result.decision.status, headers: { ...result.headers, "content-type": "application/json" } });
      }
      return withHeaders(await handler.fetch.call(this ?? handler, request, env, ctx), result.headers);
    },
  };
}

let reported = false;
function defaultOnError(e) {
  if (reported) return;
  reported = true;
  console.error(`[ludion] Gate disabled, requests pass through: ${e?.message ?? e}`);
}
