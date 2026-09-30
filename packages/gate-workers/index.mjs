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
import { createGate } from "@ludion/gate-core";
import { gateConfig } from "@ludion/gate-core/config";

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
 * @param {{ configVar?: string, onError?: (e: unknown) => void }} [options]
 * @returns {H}
 */
export function withLudion(handler, { configVar = "LUDION", onError = defaultOnError } = {}) {
  let ready;
  const pending = [];
  // The sink is never awaited by the Gate; each delivery is handed to ctx.waitUntil so the
  // runtime does not cancel it when the response is returned.
  const trackedFetch = (...args) => { const p = fetch(...args); pending.push(p); return p; };
  const init = async (env) => createGate(await gateConfig(env?.[configVar], { siteKey: env?.LUDION_SITE_KEY, fetch: trackedFetch }));

  return {
    ...handler,
    async fetch(request, env, ctx) {
      let gate;
      try { gate = await (ready ??= init(env)); }
      catch (e) { ready = Promise.reject(e); ready.catch(() => {}); onError(e); return handler.fetch.call(this ?? handler, request, env, ctx); } // never take the site down
      const result = await gate.inspect(describe(request), { ip: request.headers.get("cf-connecting-ip") ?? undefined, country: request.cf?.country });
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
