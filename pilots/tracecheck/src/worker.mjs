// The Ludion Gate at Pressure 0 in front of tracecheck.dev, on a zone Worker route. It only
// observes: every request goes on to the site exactly as it came, and the site's response comes
// back exactly as the site sent it, to people and agents alike. The Gate looks at the request after
// it has gone on (ctx.waitUntil), and what it classifies as automation is kept in the site's own D1
// (observe.mjs, store.mjs). A fault in here is the pilot's, never the site's: the request still
// reaches the site (passThroughOnException), and nothing the Gate does can hold a response.
//
// Every morning (the cron in wrangler.jsonc) yesterday's report is written from those rows
// (daily.mjs).
import { createGate, bodyNeeded, readWebBody } from "@ludion/gate-core";
import { gateConfig } from "@ludion/gate-core/config";
import { eventRow } from "./observe.mjs";
import { store } from "./store.mjs";
import { daily } from "./daily.mjs";

/**
 * The site config (the LUDION var), held to what an observer may be: Pressure 0 everywhere, and
 * no endpoint to send events to (they stay in D1). Anything else is refused, not quietly applied.
 * @returns {object} the parsed config
 */
export function observeOnly(spec) {
  if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch (e) { throw new TypeError(`LUDION is not JSON: ${e.message}`); } }
  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError("LUDION must be the site config object");
  if ((spec.pressure ?? 0) !== 0) throw new TypeError(`LUDION.pressure must be 0: this Worker only observes (got ${JSON.stringify(spec.pressure)})`);
  for (const [i, r] of (Array.isArray(spec.routes) ? spec.routes : []).entries()) {
    if ((r?.pressure ?? 0) !== 0) throw new TypeError(`LUDION.routes[${i}].pressure must be 0: this Worker only observes`);
  }
  if (spec.report != null) throw new TypeError("LUDION.report must be unset: events stay in this account's D1 and are sent nowhere");
  return spec;
}

/** Web Request → RFC 9421 RequestDescriptor. */
function describe(request) {
  const fields = [];
  request.headers.forEach((value, name) => { fields.push({ name, value }); });
  return { kind: "request", method: request.method, targetUri: request.url, fields };
}

/** One Worker: a Gate per isolate, made on the first request. */
export function createPilot({ log = console } = {}) {
  let gate;
  const said = new Set();
  const complain = (where, e) => {
    if (said.has(where)) return; // once per isolate and kind: a broken D1 must not flood the logs
    said.add(where);
    log.error(`[ludion pilot] ${where}: ${e?.message ?? e}`);
  };
  const boot = async (env) => {
    const config = await gateConfig(observeOnly(env.LUDION), { siteKey: env.LUDION_SITE_KEY });
    return createGate({ ...config, sink: undefined, sendMetadata: false });
  };

  async function observe(request, desc, body, env) {
    let g;
    try { g = await (gate ??= boot(env)); }
    catch (e) { complain("gate disabled", e); return; } // the rejection stays cached: one boot per isolate
    if (body) desc.body = await body;
    const row = eventRow(await g.inspect(desc), request);
    if (!row) return;
    try { await store(env.EVENTS).insert(row); }
    catch (e) { complain("d1 insert", e); }
  }

  return {
    fetch(request, env, ctx) {
      ctx.passThroughOnException();
      try {
        const desc = describe(request);
        // A signature that covers content-digest needs the body: a copy, taken before the request
        // goes on, so the site still gets every byte (readWebBody clones synchronously).
        const body = bodyNeeded(desc) ? readWebBody(request) : null;
        ctx.waitUntil(observe(request, desc, body, env).catch((e) => complain("observe", e)));
      } catch (e) { complain("observe", e); }
      return fetch(request);
    },

    async scheduled(controller, env) {
      const spec = observeOnly(env.LUDION);
      const r = await daily({
        db: env.EVENTS, site: spec.site_id, tz: env.REPORT_TZ || "Asia/Tokyo", now: controller.scheduledTime,
        webhook: env.REPORT_WEBHOOK_URL || undefined, retainDays: Number(env.RETAIN_DAYS ?? 90),
      });
      log.log(`[ludion pilot] report ${spec.site_id} ${r.date}: ${r.summary.events} automated requests`);
      if (r.problems.length) throw new Error(`report ${r.date} saved, but: ${r.problems.join("; ")}`);
    },
  };
}

export default createPilot();
