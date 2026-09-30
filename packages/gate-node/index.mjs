// @ludion/gate-node — Gate middleware for Node's http module, Express, Connect, Fastify (via middie).
//
//   import { ludionGate } from "@ludion/gate-node";
//   app.use(await ludionGate({ siteId, siteKey, pressure: 0 }));
//
// Translates IncomingMessage → RFC 9421 RequestDescriptor, runs the Gate, applies
// the decision. Humans are never affected: decisions apply only to requests the
// Gate classified as automation, and Pressure 0 (default) only observes.

import { createGate } from "@ludion/gate-core";

/**
 * @param {import("@ludion/gate-core").GateConfig & { trustProxy?: boolean, onFriction?: (req,res,next,result)=>void }} config
 */
export async function ludionGate(config) {
  const gate = await createGate(config);
  const trustProxy = !!config.trustProxy;

  function describe(req) {
    const fields = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) fields.push({ name: req.rawHeaders[i], value: req.rawHeaders[i + 1] });
    const proto = trustProxy && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
      : (req.socket?.encrypted ? "https" : "http");
    const host = trustProxy && req.headers["x-forwarded-host"] ? String(req.headers["x-forwarded-host"]).split(",")[0].trim()
      : (req.headers.host ?? req.headers[":authority"] ?? "localhost");
    return { kind: "request", method: req.method, targetUri: `${proto}://${host}${req.url}`, fields };
  }

  function clientIp(req) {
    if (trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket?.remoteAddress;
  }

  const middleware = async function ludionMiddleware(req, res, next) {
    let result;
    try {
      result = await gate.inspect(describe(req), { ip: clientIp(req), country: req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] });
    } catch {
      return next(); // never take the site down
    }
    req.ludion = result;
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    if (result.decision.action === "deny") {
      res.statusCode = result.decision.status;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: result.decision.error, help: `https://ludion.ai/e/${result.decision.error}` }));
    }
    if (result.decision.action === "friction" && config.onFriction) return config.onFriction(req, res, next, result);
    return next();
  };
  middleware.gate = gate;
  return middleware;
}
