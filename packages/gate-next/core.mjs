// @ludion/gate-next core: the Next.js proxy without importing Next (so it is testable anywhere).
// Next.js 16 runs proxy.js on the Node.js runtime, before routing, for every request.
import { createGate, bodyNeeded, readWebBody } from "@ludion/gate-core";
import { gateConfig } from "@ludion/gate-core/config";
import { createSafeFetch } from "@ludion/gate-core/safe-fetch";

/** ludion.config.json (or $LUDION_CONFIG) from the directory `next start` / `next dev` runs in. */
export async function readConfigFile(env = process.env) {
  const [{ readFileSync }, { resolve }] = await Promise.all([import("node:fs"), import("node:path")]);
  return JSON.parse(readFileSync(resolve(process.cwd(), env.LUDION_CONFIG || "ludion.config.json"), "utf8"));
}

/** Web Request → RFC 9421 RequestDescriptor. Headers arrive combined, which is RFC 9421's form. */
export function describe(request) {
  const fields = [];
  request.headers.forEach((value, name) => { fields.push({ name, value }); });
  return { kind: "request", method: request.method, targetUri: request.url, fields };
}

/**
 * @param {{ next: () => Response, loadConfig?: (env: object) => Promise<object>, env?: Record<string, string|undefined>,
 *           onError?: (e: unknown) => void, resolver?: { lookup?: Function, dial?: Function, insecureAllowHttp?: boolean } }} deps
 *        next: NextResponse.next — continue to the app with the headers set on the returned response.
 *        resolver: tests only (name resolution, where a checked address is reached), as gate-node's config.resolver.
 */
export function createNextGate({ next, loadConfig = readConfigFile, env = process.env, onError = defaultOnError, resolver = {} }) {
  let ready;
  // proxy.js runs on Node: key discovery goes through the safe transport, which checks and pins
  // every resolved address, as in gate-node (GATE-6, GATE-12). Never the runtime's plain fetch.
  const init = async () => {
    const config = await gateConfig(await loadConfig(env), { siteKey: env.LUDION_SITE_KEY });
    const { lookup, dial, ...rest } = resolver;
    const fetch = createSafeFetch({ lookup, dial, allowPrivateNetwork: rest.allowPrivateNetwork });
    return createGate({ ...config, resolver: { ...config.resolver, ...rest, fetch } });
  };

  async function proxy(request) {
    let gate;
    try { gate = await (ready ??= init()); }
    catch (e) { ready = Promise.reject(e); ready.catch(() => {}); onError(e); return next(); } // a broken config never takes the site down
    const desc = describe(request);
    // Only a signature that covers content-digest makes the Gate read the body: a clone, to check it (GATE-11).
    if (bodyNeeded(desc)) desc.body = await readWebBody(request);
    const result = await gate.inspect(desc, {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim(), country: request.headers.get("x-vercel-ip-country") ?? undefined,
    });
    if (result.decision.action === "deny") {
      return new Response(JSON.stringify({ error: result.decision.error, help: `https://ludion.ai/e/${result.decision.error}` }),
        { status: result.decision.status, headers: { ...result.headers, "content-type": "application/json" } });
    }
    const res = next();
    for (const [k, v] of Object.entries(result.headers)) res.headers.set(k, v);
    return res;
  }
  return { proxy, get gate() { return ready; } };
}

let reported = false;
function defaultOnError(e) {
  if (reported) return;
  reported = true;
  console.error(`[ludion] Gate disabled, requests pass through: ${e?.message ?? e}`);
}
