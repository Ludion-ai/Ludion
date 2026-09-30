// The conformance vectors (accept/conformance/vectors.json), run by the TypeScript Gate from the
// data alone: the same file a Gate in any other language reads (GATE-9). Portable like the rest of
// this directory (NEUT-1): Web APIs and @ludion/gate-core only, time and key discovery injected,
// no network. Hosts import the JSON and call registerConformance(vectors).
//
// Per case: build each Gate from its spec (the site's routes at Pressure 0, its authorities, the
// Registry's keys, the directories it knows, the documents served at URLs), then send the steps in
// order at `now + atS`. A `core` step goes to gate.inspect(); a `raw` step is a request as a Node
// server receives it and goes through what @ludion/gate-node does with one (Host or, behind a
// trusted proxy, X-Forwarded-Host; the path of an absolute-form target; deny answers, anything
// else reaches the app). A step must meet its expectation, and on this, the reference
// implementation, give exactly the reference answer recorded in the file.
import { createGate, createResolver, generateSiteKey, originForm } from "@ludion/gate-core";
import { verify } from "web-bot-auth";

const first = (v) => String(v).split(",")[0].trim();

/** What @ludion/gate-node makes of a raw request (packages/gate-node/index.mjs describe()). */
async function throughAdapter(gate, spec, raw) {
  const fields = [];
  for (let i = 0; i < raw.rawHeaders.length; i += 2) fields.push({ name: raw.rawHeaders[i], value: raw.rawHeaders[i + 1] });
  const headers = {};
  for (const f of fields) { const k = f.name.toLowerCase(); headers[k] = k in headers ? `${headers[k]}, ${f.value}` : f.value; }
  const trust = !!spec.trustProxy;
  const proto = trust && headers["x-forwarded-proto"] ? first(headers["x-forwarded-proto"]) : raw.tls ? "https" : "http";
  const host = trust && headers["x-forwarded-host"] ? first(headers["x-forwarded-host"]) : headers.host ?? "localhost";
  const ip = trust && headers["x-forwarded-for"] ? first(headers["x-forwarded-for"]) : raw.remoteAddress;
  const result = await gate.inspect({ kind: "request", method: raw.method, targetUri: `${proto}://${host}${originForm(raw.target)}`, fields }, { ip });
  return { result, reachedApp: result.decision.action !== "deny" };
}

/** The shape every refusal must have (packages/gate-core/test/support.mjs rejected()). */
export function refusalProblems(r, { victim } = {}) {
  const problems = [];
  const c = r.cls;
  if (c.class === "VERIFIED") problems.push(`class VERIFIED (identifier ${c.identifier}, depth ${c.depth})`);
  if (c.class !== "REVOKED" && (c.diverId || c.staple || (c.depth ?? 0) > 0)) problems.push(`non-VERIFIED result carries Staple standing (diver ${c.diverId}, depth ${c.depth})`);
  if (victim && c.class === "VERIFIED" && c.identifier === victim) problems.push(`attributed to ${victim}`);
  if (r.route.pressure >= 2 && r.decision.action !== "deny") problems.push(`decision ${r.decision.action} on a Pressure ${r.route.pressure} route`);
  return problems;
}

/**
 * Run one case. Throws on the first step that does not hold.
 * @param {object} c a case from vectors.json @param {object} d the file's defaults
 */
export async function runCase(c, d) {
  const start = c.now ?? d.now;
  let t = start;
  const docs = new Map((c.world.documents ?? []).map((x) => [x.url, x]));
  const fetch = async (url) => {
    const x = docs.get(String(url));
    return x ? new Response(JSON.stringify(x.body), { status: 200, headers: { "content-type": x.contentType } }) : new Response("", { status: 404 });
  };
  const gates = {};
  for (const [id, g] of Object.entries(c.gates)) {
    const siteKey = await generateSiteKey();
    const gate = await createGate({
      siteId: d.siteId, siteKey: siteKey.privateJwk, pressure: d.pressure, routes: d.routes, now: () => t,
      authorities: g.authorities, resolver: { fetch },
      ...(c.world.registry?.keys?.length ? { registryKeys: { keys: c.world.registry.keys }, registryIssuer: c.world.registry.issuer } : {}),
      ...(g.nonceCache ? { nonceCache: g.nonceCache } : {}),
    });
    for (const dir of g.directories ?? []) await gate.resolver.prime({ type: "directory", uri: dir.uri }, { keys: dir.keys });
    gates[id] = { gate, spec: g };
  }
  const victim = "https://agent.example";
  for (const [i, s] of c.steps.entries()) {
    t = start + s.atS * 1000;
    if (s.signature) { await signatureStep(s, i, t); continue; }
    const g = gates[s.gate];
    if (!g) throw new Error(`step ${i}: no gate ${s.gate}`);
    let r, reachedApp;
    if (s.raw) ({ result: r, reachedApp } = await throughAdapter(g.gate, g.spec, s.raw));
    else r = await g.gate.inspect({ kind: "request", method: s.core.method, targetUri: s.core.targetUri, fields: s.core.fields });
    const got = `${r.cls.class} ${r.decision.action}${r.decision.error ? ` ${r.decision.error}` : ""}${s.raw ? (reachedApp ? " reached" : " stopped") : ""}`;
    const at = `step ${i} (${s.expect}): got ${got}`;
    if (s.expect === "verified" && r.cls.class !== "VERIFIED") throw new Error(`${at}, expected VERIFIED`);
    if (s.expect === "human" && (!reachedApp || r.headers["Ludion-Error"])) throw new Error(`${at}, expected to reach the app untouched`);
    if (s.expect === "denied" && (reachedApp !== false || ![401, 403].includes(r.decision.status))) throw new Error(`${at}, expected 401/403 before the app`);
    if (s.expect === "rejected") {
      const p = refusalProblems(r, { victim });
      if (s.raw && (reachedApp || !r.headers["Ludion-Error"])) p.push("reached the app");
      if (p.length) throw new Error(`${at}: GOT THROUGH — ${p.join("; ")}`);
    }
    if (!["verified", "human", "denied", "rejected", "flood"].includes(s.expect)) throw new Error(`step ${i}: unknown expectation ${s.expect}`);
    const ref = s.reference;
    if (ref && (ref.class !== r.cls.class || ref.action !== r.decision.action || (ref.error ?? undefined) !== (r.decision.error ?? undefined)
      || (ref.reachedApp !== undefined && ref.reachedApp !== reachedApp))) {
      throw new Error(`${at}, but the reference answered ${ref.class} ${ref.action}${ref.error ? ` ${ref.error}` : ""}${ref.reachedApp === undefined ? "" : ref.reachedApp ? " reached" : " stopped"}`);
    }
  }
}

/**
 * A `signature` step: the request's RFC 9421 / Web Bot Auth signature on its own, with the lifetime
 * left to the caller (a Gate adds its 60 s on top). `valid` must verify under the listed
 * directories with the reference keyid and identifier; `invalid` must not verify.
 */
async function signatureStep(s, i, t) {
  const r = createResolver({ now: () => t });
  for (const dir of s.signature.directories) await r.prime({ type: "directory", uri: dir.uri }, { keys: dir.keys });
  let v, err;
  try { v = await verify({ kind: "request", ...s.signature.request }, { resolver: (c) => r.resolve(c), now: new Date(t), maxAge: 1e12 }); }
  catch (e) { err = e; }
  if (s.expect === "valid") {
    if (err) throw new Error(`step ${i} (valid): did not verify: ${err?.message ?? err}`);
    if (s.reference && (v.keyid !== s.reference.keyid || v.verifier.identifier !== s.reference.identifier)) {
      throw new Error(`step ${i} (valid): verified as ${v.keyid} from ${v.verifier.identifier}, the reference is ${s.reference.keyid} from ${s.reference.identifier}`);
    }
  } else if (s.expect === "invalid") {
    if (!err) throw new Error(`step ${i} (invalid): verified as ${v.keyid}`);
  } else throw new Error(`step ${i}: unknown signature expectation ${s.expect}`);
}

/** Register one test per case with the portable shim (or node:test). */
export function registerConformance(vectors, { test }) {
  if (vectors?.version !== 1 || !Array.isArray(vectors.cases)) throw new Error("conformance vectors: unknown format");
  for (const c of vectors.cases) test(`conformance: ${c.id}`, () => runCase(c, vectors.defaults));
}
