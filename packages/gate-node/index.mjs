// @ludion/gate-node — Gate middleware for Node's http module, Express, Connect, Fastify (via middie).
//
//   import { ludionGate } from "@ludion/gate-node";
//   app.use(await ludionGate({ siteId, siteKey, pressure: 0 }));
//
// Translates IncomingMessage → RFC 9421 RequestDescriptor, runs the Gate, applies
// the decision. Humans are never affected: decisions apply only to requests the
// Gate classified as automation, and Pressure 0 (default) only observes.

import { createGate, originForm, bodyNeeded, DEFAULT_MAX_BODY_BYTES, DEFAULT_BODY_TIMEOUT_MS } from "@ludion/gate-core";
import { createSafeFetch } from "@ludion/gate-core/safe-fetch";
import { sqliteLedger } from "./ledger.mjs";

export { createSafeFetch, sqliteLedger };

/**
 * The body of an IncomingMessage, for the Gate to check a signed Content-Digest (GATE-11), handed
 * back to the stream before the app sees it: read in paused mode, then unshifted in the same tick
 * as the last read, so 'end' cannot fire in between and the app's parser reads every byte. Past
 * `maxBytes`, or after `timeoutMs`, what was read goes back and the body is left unchecked (never
 * VERIFIED). A body already read before the Gate ran cannot be checked. Never throws.
 * @returns {Promise<Uint8Array | { unavailable: string }>}
 */
export function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  const announced = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  if (!announced) return Promise.resolve(new Uint8Array(0)); // HTTP framing says there is no body
  // Read (or being read) before the Gate ran: a body parser mounted first. Nothing left to check.
  if (req.readableEnded || req.readableFlowing === true || req._body) return Promise.resolve({ unavailable: "body_consumed" });
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0, done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("readable", onReadable); req.off("error", onError); req.off("aborted", onAbort);
      if (chunks.length) req.unshift(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
      resolve(out);
    };
    const onReadable = () => {
      let c;
      while ((c = req.read()) !== null) {
        chunks.push(c); n += c.length;
        if (n > maxBytes) return finish({ unavailable: "body_too_large" });
      }
      // IncomingMessage marks the message complete before it pushes the end; other streams only internally.
      if (req.complete === true || req._readableState?.ended === true) finish(new Uint8Array(Buffer.concat(chunks)));
    };
    const onError = () => finish({ unavailable: "body_error" });
    const onAbort = () => finish({ unavailable: "body_error" });
    const timer = setTimeout(() => finish({ unavailable: "body_timeout" }), timeoutMs);
    timer.unref?.();
    req.on("readable", onReadable); req.on("error", onError); req.on("aborted", onAbort);
    onReadable();
  });
}

/**
 * Key discovery on Node goes through createSafeFetch unless `resolver.fetch` is given: every
 * resolved address is checked and pinned (GATE-6). `resolver.lookup` replaces name resolution.
 * @param {import("@ludion/gate-core").GateConfig & { trustProxy?: boolean, onFriction?: (req,res,next,result)=>void }} config
 */
export async function ludionGate(config) {
  const r = config.resolver ?? {};
  const fetch = r.fetch ?? createSafeFetch({ lookup: r.lookup, maxBytes: r.maxBytes, allowPrivateNetwork: r.allowPrivateNetwork, dial: r.dial });
  const gate = await createGate({ ...config, resolver: { ...r, fetch } });
  const trustProxy = !!config.trustProxy;

  function describe(req) {
    const fields = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) fields.push({ name: req.rawHeaders[i], value: req.rawHeaders[i + 1] });
    const proto = trustProxy && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
      : (req.socket?.encrypted ? "https" : "http");
    const host = trustProxy && req.headers["x-forwarded-host"] ? String(req.headers["x-forwarded-host"]).split(",")[0].trim()
      : (req.headers.host ?? req.headers[":authority"] ?? "localhost");
    // An absolute-form target is routed by the app on its path (RFC 9112 §3.2.2), so it is
    // described on that path; gluing it after the Host would move it off its Pressure 2 route.
    return { kind: "request", method: req.method, targetUri: `${proto}://${host}${originForm(req.url)}`, fields };
  }

  function clientIp(req) {
    if (trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket?.remoteAddress;
  }

  const bodyLimits = { maxBytes: config.maxBodyBytes, timeoutMs: config.bodyTimeoutMs };
  const middleware = async function ludionMiddleware(req, res, next) {
    let result;
    try {
      const desc = describe(req);
      // Only a signature that covers content-digest makes the Gate read the body (to check it).
      if (bodyNeeded(desc)) desc.body = await readBody(req, bodyLimits);
      result = await gate.inspect(desc, { ip: clientIp(req), country: req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] });
    } catch (e) {
      result = gate.failSafe(req.url, e); // inspect never throws; this is the last line, and it still honours fail_mode
    }
    req.ludion = result;
    // Where the handler knows the amount: const v = await req.ludion.charge({ amount, currency });
    // if (!v.ok) answer v.status with v.headers (spec §10.6 limits; never enforced on humans).
    result.charge = (c) => gate.charge(result, c);
    try {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    } catch { /* a header we cannot set must not take the site down */ }
    if (result.decision.action === "deny") {
      res.statusCode = result.decision.status;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: result.decision.error, help: `https://ludion.ai/e/${result.decision.error}` }));
    }
    if (result.decision.action === "friction" && config.onFriction) return config.onFriction(req, res, next, result);
    return next();
  };
  middleware.gate = gate;
  // Hourly counts are sent when an hour closes (ADR-038). The Gate sends them on the next request;
  // this sends them on a quiet site too. It never keeps the process alive.
  const flusher = setInterval(() => gate.flush(), 60_000);
  flusher.unref?.();
  return middleware;
}

/**
 * The 60-second install (ADR-022):
 *
 *   import { ludion } from "@ludion/gate-node";
 *   app.use(await ludion());
 *
 * Reads ludion.config.json (or the file named by $LUDION_CONFIG) from the working directory and
 * the Glass receipt key from $LUDION_SITE_KEY (a secret, never in the config file).
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, config?: object, onFriction?: Function }} [options]
 */
export async function ludion(options = {}) {
  const [{ readFileSync }, { resolve }, { gateConfig }] = await Promise.all([import("node:fs"), import("node:path"), import("@ludion/gate-core/config")]);
  const env = options.env ?? process.env;
  const spec = options.config ?? JSON.parse(readFileSync(resolve(options.cwd ?? process.cwd(), env.LUDION_CONFIG || "ludion.config.json"), "utf8"));
  const { mandateLedgerFile, ...config } = await gateConfig(spec, { siteKey: env.LUDION_SITE_KEY });
  // mandate_ledger: { "sqlite": file } — the per_day record every Gate process of the site shares (PRS-3).
  if (mandateLedgerFile) config.mandateLedger = await sqliteLedger(resolve(options.cwd ?? process.cwd(), mandateLedgerFile));
  return ludionGate({ ...config, ...(options.onFriction ? { onFriction: options.onFriction } : {}) });
}
