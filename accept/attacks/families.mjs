// GATE-7 attack families: each turns a corpus entry (accept/attacks/*.json: `family`, `params`)
// into steps against a fresh world. Shared by the GATE-7 runner (run.mjs), which executes them,
// and the conformance exporter (accept/conformance/export.mjs), which writes them out as data
// for Gates in other languages (GATE-9).
//
// A world: a victim agent with a sibling key and a Staple, an attacker with their own directory
// and Staple, a pinned Registry, a Gate at P0 with Pressure-2 routes. A step is
// { req, atS, expect } against the world's Gate, or { gate, … } / { node, … } against another
// Gate or the real @ludion/gate-node adapter. Expectations: verified | rejected | human | denied | flood.
import { Readable } from "node:stream";
import { component } from "http-message-sig";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey, originForm, MANDATE_TYP } from "@ludion/gate-core";
import { signJws } from "@ludion/gate-core/staple";
import { createHash } from "node:crypto";
import { keypair as supportKeypair, signed as supportSigned, harness as supportHarness, staple, withFields, fieldOf, retarget, digestOf, AGENT, ATTACKER, SITE, NOW_MS, NOW_S, ROUTES, REGISTRY_ISS } from "../../packages/gate-core/test/support.mjs";

/**
 * What families build worlds with. The conformance exporter (accept/conformance/export.mjs) swaps in
 * a Gate builder that records, and keys and nonces seeded from the case id, so its file is
 * reproducible byte for byte.
 */
export const deps = { harness: supportHarness, keypair: supportKeypair, signed: supportSigned };

export const REQUIRED = ["replay", "staple-swap", "cnf-mismatch", "strip-signature", "key-confusion", "label-confusion", "omitted-components", "clock-skew", "route-evasion", "cross-site-replay", "nonce-flood", "mandate-swap", "body-swap"];
export const UAS = {
  human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  suspected: "python-requests/2.32.3",
  declared: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
};
export const VICTIM_DIVER = "dvr-victimvictimvic2", ATTACKER_DIVER = "dvr-attackerattacke2";

export async function world() {
  const [agent, sibling, attacker, registry] = await Promise.all([deps.keypair(), deps.keypair(), deps.keypair(), deps.keypair()]);
  const w = { t: NOW_MS, agent, sibling, attacker, registry, docs: new Map() };
  const fetch = async (url) => {
    const doc = w.docs.get(String(url));
    return doc ? new Response(JSON.stringify(doc.body), { status: 200, headers: { "content-type": doc.type ?? "application/json" } }) : new Response("", { status: 404 });
  };
  w.fetch = fetch;
  w.gate = await deps.harness({ agentKeys: [agent, sibling], attackerKeys: [attacker], registry, now: () => w.t, resolver: { fetch } });
  w.victimStaple = await staple(registry, { sub: VICTIM_DIVER, jkt: agent.kid, depth: 2 });
  w.attackerStaple = await staple(registry, { sub: ATTACKER_DIVER, jkt: attacker.kid, depth: 1 });
  return w;
}

/**
 * The same world behind the real Node adapter (same routes, keys and Registry), built on first
 * use per adapter option set (e.g. `{ trustProxy: true }`).
 */
export async function nodeGate(w, opts = {}) {
  const k = JSON.stringify(opts);
  w.nodes ??= new Map();
  if (w.nodes.has(k)) return w.nodes.get(k);
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({ siteId: "site-test", siteKey: siteKey.privateJwk, pressure: 0, now: () => w.t, routes: ROUTES,
    authorities: [new URL(SITE).host], registryKeys: { keys: [w.registry.publicJwk] }, registryIssuer: REGISTRY_ISS, resolver: { fetch: w.fetch }, ...opts });
  await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [w.agent, w.sibling].map((k) => ({ ...k.publicJwk, use: "sig" })) });
  await mw.gate.resolver.prime({ type: "directory", uri: ATTACKER }, { keys: [{ ...w.attacker.publicJwk, use: "sig" }] });
  mw.conformance = { adapter: "node", options: opts };
  w.nodes.set(k, mw);
  return mw;
}

/**
 * An IncomingMessage as Node hands it to the app: the raw request-target, raw headers, a TLS socket,
 * and the body as a stream with the Content-Length that frames it (the Gate reads it to check a
 * signed Content-Digest, GATE-11).
 */
export function incoming(desc, target) {
  let fields = desc.fields.some((f) => f.name.toLowerCase() === "host") ? desc.fields : [{ name: "host", value: new URL(SITE).host }, ...desc.fields];
  const body = desc.body == null ? null : Buffer.from(desc.body);
  if (body && !fields.some((f) => f.name.toLowerCase() === "content-length")) fields = [...fields, { name: "content-length", value: String(body.length) }];
  const headers = {};
  for (const f of fields) { const k = f.name.toLowerCase(); headers[k] = k in headers ? `${headers[k]}, ${f.value}` : f.value; }
  return Object.assign(Readable.from(body ? [body] : []), { method: desc.method, url: target, rawHeaders: fields.flatMap((f) => [f.name, f.value]), headers, socket: { encrypted: true, remoteAddress: "203.0.113.7" },
    conformanceBody: body ? body.toString("utf8") : null }); // what the conformance export writes as the raw body
}

/** Run one request through the adapter: did it reach the app, and what did the Gate decide? */
export function throughNode(mw, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; },
      end() { resolve({ reachedApp: false, status: this.statusCode, headers: this.h, result: req.ludion }); } };
    Promise.resolve(mw(req, res, () => resolve({ reachedApp: true, status: 200, headers: res.h, result: req.ludion }))).catch(reject);
  });
}

const url = (p) => `${SITE}${p ?? "/checkout/1"}`;
const covered = (list) => list.map((c) => (typeof c === "string" ? c : component(c.name, c.params ?? {})));
const stapled = (key, s, extra = {}) => deps.signed({ key, extraComponents: ["ludion-staple"], ...extra, headers: { ...extra.headers, "ludion-staple": s } });
const ok = (req, atS = 0) => ({ req, atS, expect: "verified" });
const bad = (req, atS = 0) => ({ req, atS, expect: "rejected" });

export const FAMILIES = {
  // Resend a captured signed request. `delayS`: when the copy arrives; `nonce: false`: the
  // signer did not send a nonce (third-party signers may not); `replayPath`: send the captured
  // fields to another path on the same authority (a GET signature does not cover @path).
  async replay({ method = "GET", path: p, body, delayS = 1, nonce = true, replayPath }, w) {
    const req = await deps.signed({ key: w.agent, method, url: url(p), body, ...(nonce ? {} : { nonce: null }) });
    return [ok(req), bad(replayPath ? retarget(req, url(replayPath)) : req, delayS)];
  },
  // Replace, add or drop the Ludion-Staple under someone's signature.
  async "staple-swap"({ variant }, w) {
    if (variant === "swap-in-victim-staple") {
      const mine = await stapled(w.attacker, w.attackerStaple, { agent: ATTACKER });
      const control = await stapled(w.attacker, w.attackerStaple, { agent: ATTACKER });
      return [ok(control), bad(withFields(mine, { "ludion-staple": w.victimStaple }))];
    }
    if (variant === "uncovered-staple") {
      const mine = await deps.signed({ key: w.attacker, agent: ATTACKER });
      return [ok(await deps.signed({ key: w.attacker, agent: ATTACKER })), bad(withFields(mine, { "ludion-staple": w.victimStaple }))];
    }
    if (variant === "strip-covered-staple") {
      const req = await stapled(w.agent, w.victimStaple);
      return [ok(await stapled(w.agent, w.victimStaple)), bad(withFields(req, { "ludion-staple": undefined }))];
    }
    if (variant === "tamper-staple-payload") {
      const req = await stapled(w.agent, w.victimStaple);
      const [h, , s] = w.victimStaple.split(".");
      const forged = Buffer.from(JSON.stringify({ iss: "https://registry.ludion.ai", sub: VICTIM_DIVER, iat: NOW_S, exp: NOW_S + 3600, depth: 4, ballast: { status: "active" }, cnf: { jkt: [w.agent.kid] } })).toString("base64url");
      const reSigned = await stapled(w.agent, `${h}.${forged}.${s}`);
      return [ok(req), bad(reSigned)];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Carry a delegation one was never given (spec §10.6): a Mandate is the Registry's, for one
  // Diver (read through the Staple bound to the request key), covered by the signature. Control:
  // the attacker's own Mandate under its own Staple is VERIFIED with the Mandate read.
  async "mandate-swap"({ variant }, w) {
    const mandateOf = (sub, extra = {}) => signJws(w.registry.privateKey, w.registry.kid, MANDATE_TYP, {
      iss: REGISTRY_ISS, sub, prn: "pw-conformance", aud: SITE, scope: ["checkout"], limits: { checkout_max: 5000, currency: "JPY", per_day: 3 },
      iat: NOW_S - 60, exp: NOW_S + 86_400, jti: `mdt-${sub.slice(4)}`, ...extra });
    const carrying = (mandate, { cover = true } = {}) => deps.signed({ key: w.attacker, agent: ATTACKER,
      extraComponents: ["ludion-staple", ...(cover ? ["ludion-mandate"] : [])],
      headers: { "ludion-staple": w.attackerStaple, "ludion-mandate": mandate } });
    const control = ok(await carrying(await mandateOf(ATTACKER_DIVER)));
    if (variant === "victims-mandate-under-my-staple") return [control, bad(await carrying(await mandateOf(VICTIM_DIVER)))];
    if (variant === "uncovered-mandate") return [control, bad(await carrying(await mandateOf(ATTACKER_DIVER), { cover: false }))];
    if (variant === "rewritten-limits") {
      const [h, p, s] = (await mandateOf(ATTACKER_DIVER)).split(".");
      const raised = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), limits: { checkout_max: 50_000_000, currency: "JPY" } })).toString("base64url");
      return [control, bad(await carrying(`${h}.${raised}.${s}`))];
    }
    if (variant === "staple-as-mandate") return [control, bad(await carrying(w.attackerStaple))];
    throw new Error(`unknown variant ${variant}`);
  },
  // A Staple bound (cnf.jkt) to one key presented under a signature by another key.
  async "cnf-mismatch"({ variant }, w) {
    if (variant === "sibling-key") return [ok(await deps.signed({ key: w.sibling })), bad(await stapled(w.sibling, w.victimStaple))];
    if (variant === "attacker-key") return [ok(await deps.signed({ key: w.attacker, agent: ATTACKER })), bad(await stapled(w.attacker, w.victimStaple, { agent: ATTACKER }))];
    throw new Error(`unknown variant ${variant}`);
  },
  // Strip (part of) the signature, keep the rest, hoping to be judged as something milder.
  async "strip-signature"({ remove, ua }, w) {
    const headers = ua ? { "user-agent": ua } : {};
    const req = await stapled(w.agent, w.victimStaple, { headers });
    const patch = Object.fromEntries(remove.map((h) => [h, undefined]));
    return [ok(await stapled(w.agent, w.victimStaple, { headers })), bad(withFields(req, patch))];
  },
  // Make the victim's identifier vouch for a key it never published.
  async "key-confusion"({ variant }, w) {
    const a = w.attacker;
    if (variant === "claim-victim-directory") return [ok(await deps.signed({ key: a, agent: ATTACKER })), bad(await deps.signed({ key: a, agent: AGENT }))];
    if (variant === "warm-cache-then-claim") {
      return [ok(await deps.signed({ key: a, agent: ATTACKER })), ok(await deps.signed({ key: a, agent: ATTACKER })), bad(await deps.signed({ key: a, agent: AGENT }))];
    }
    if (variant === "multi-member-cover-victim") {
      const agentHeader = `v="${AGENT}", x="${ATTACKER}"`;
      return [ok(await deps.signed({ key: a, agentHeader, agentKey: "x" })), bad(await deps.signed({ key: a, agentHeader, agentKey: "v" }))];
    }
    if (variant === "cimd-card-claims-victim-client-id") {
      w.docs.set(`${ATTACKER}/card`, { body: { client_id: `${ATTACKER}/card`, client_name: "A", jwks: { keys: [{ ...a.publicJwk, use: "sig" }] } } });
      w.docs.set(`${ATTACKER}/lying-card`, { body: { client_id: `${AGENT}/card`, client_name: "A", jwks: { keys: [{ ...a.publicJwk, use: "sig" }] } } });
      return [ok(await deps.signed({ key: a, agentHeader: `sig1="${ATTACKER}/card";type=cimd` })),
        bad(await deps.signed({ key: a, agentHeader: `sig1="${ATTACKER}/lying-card";type=cimd` }))];
    }
    if (variant === "http-directory") {
      w.docs.set(`http://agent.example/.well-known/http-message-signatures-directory`, { body: { keys: [{ ...a.publicJwk, use: "sig" }] } });
      return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: a, agent: "http://agent.example" }))];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Confuse which signature, label or Signature-Agent member the Gate evaluates.
  async "label-confusion"({ variant }, w) {
    if (variant === "append-own-signature") {
      const agentHeader = `sig1="${AGENT}", sig2="${ATTACKER}"`;
      const victim = await deps.signed({ key: w.agent, agentHeader });
      const mine = await deps.signed({ key: w.attacker, agentHeader, label: "sig2", agentKey: "sig2" });
      const both = withFields(victim, {
        "signature-input": `${fieldOf(victim, "signature-input")}, ${fieldOf(mine, "signature-input")}`,
        signature: `${fieldOf(victim, "signature")}, ${fieldOf(mine, "signature")}`,
      });
      return [ok(await deps.signed({ key: w.agent, agentHeader })), bad(both)];
    }
    if (variant === "extra-input-label") {
      const req = await deps.signed({ key: w.agent });
      const extra = fieldOf(await deps.signed({ key: w.attacker, agent: ATTACKER, label: "sig2", agentHeader: `sig2="${ATTACKER}"` }), "signature-input");
      return [ok(await deps.signed({ key: w.agent })), bad(withFields(req, { "signature-input": `${fieldOf(req, "signature-input")}, ${extra}` }))];
    }
    if (variant === "cross-member-label") {
      const agentHeader = `sig1="${ATTACKER}", sig2="${AGENT}"`;
      return [ok(await deps.signed({ key: w.attacker, agentHeader, agentKey: "sig1" })), bad(await deps.signed({ key: w.attacker, agentHeader, agentKey: "sig2" }))];
    }
    if (variant === "duplicate-member") {
      return [ok(await deps.signed({ key: w.attacker, agent: ATTACKER })),
        bad(await deps.signed({ key: w.attacker, agentHeader: `sig1="${ATTACKER}", sig1="${AGENT}"` }))];
    }
    if (variant === "split-header-lines") {
      const req = await deps.signed({ key: w.attacker, agentHeader: `sig1="${ATTACKER}", sig1="${AGENT}"` });
      const fields = req.fields.filter((f) => f.name !== "signature-agent");
      fields.unshift({ name: "signature-agent", value: `sig1="${ATTACKER}"` }, { name: "signature-agent", value: `sig1="${AGENT}"` });
      return [ok(await deps.signed({ key: w.attacker, agent: ATTACKER })), bad({ ...req, fields })];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Another body under a captured signature (spec §10.4, RFC 9530, GATE-11): the signature covers
  // the Content-Digest, so only a body that hashes to it is the signed one. The headers stay exactly
  // as signed. Control: the same agent's request with the body it signed is VERIFIED.
  async "body-swap"({ variant, body = '{"sku":1,"amount":100}', swapped = '{"sku":1,"amount":900}' }, w) {
    const control = ok(await deps.signed({ key: w.agent, method: "POST", body }));
    const req = await deps.signed({ key: w.agent, method: "POST", body });
    if (variant === "other-body") return [control, bad({ ...req, body: swapped })];
    if (variant === "empty-body") return [control, bad({ ...req, body: "" })];
    if (variant === "appended-bytes") return [control, bad({ ...req, body: `${body}
` })];
    if (variant === "through-node") {
      const mw = await nodeGate(w);
      const honest = await deps.signed({ key: w.agent, method: "POST", body });
      return [{ node: mw, req: incoming(honest, "/checkout/1"), atS: 0, expect: "verified" },
        { node: mw, req: incoming({ ...req, body: swapped }, "/checkout/1"), atS: 0, expect: "rejected" }];
    }
    if (variant === "second-digest-for-other-body") {
      // sha-256 of the signed body, sha-512 of another: every digest the Gate checks must match.
      const sha512 = (b) => `sha-512=:${createHash("sha512").update(b).digest("base64")}:`;
      const both = (second) => deps.signed({ key: w.agent, method: "POST", headers: { "content-digest": `${digestOf(body)}, ${second}` },
        components: ["@authority", component("signature-agent", { key: "sig1" }), "@method", "@path", "content-digest"] }).then((r) => ({ ...r, body }));
      return [ok(await both(sha512(body))), bad(await both(sha512(swapped)))];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // A state-changing request whose signature leaves out what binds it (spec §10.4). The control
  // is the same method signed the way the Diver does it, with a body and its Content-Digest.
  async "omitted-components"({ method = "POST", cover, body, headers = {} }, w) {
    const control = await deps.signed({ key: w.agent, method, body: '{"sku":1}' });
    return [ok(control), bad(await deps.signed({ key: w.agent, method, body, headers, components: cover ? covered(cover) : undefined }))];
  },
  // Reach a Pressure-2 route through a spelling of its path that an app routes to the same
  // handler (Express: any case, a trailing slash, absolute-form; servlet containers: ;params;
  // proxies: merged slashes, decoded %XX; IIS: backslashes and trailing dots; format suffixes).
  // Controls: an honest agent on the same raw target is VERIFIED, a browser on it reaches the app
  // untouched, and the same automation on the plain spelling is denied. The attack: the
  // automation on the raw target must be denied too.
  async "route-evasion"({ method = "GET", target, canonical, ua = "suspected" }, w) {
    const mw = await nodeGate(w);
    const plain = (t, agentUa) => incoming({ kind: "request", method, targetUri: url(originForm(t)), fields: [{ name: "user-agent", value: agentUa }] }, t);
    const honest = incoming(await deps.signed({ key: w.agent, method, url: url(originForm(target)) }), target);
    return [
      { node: mw, req: honest, atS: 0, expect: "verified" },
      { node: mw, req: plain(target, UAS.human), atS: 0, expect: "human" },
      { node: mw, req: plain(canonical, UAS[ua]), atS: 0, expect: "denied" },
      { node: mw, req: plain(target, UAS[ua]), atS: 0, expect: "rejected" },
    ];
  },
  // A genuine signature captured at another site (or for another port or subdomain) and replayed
  // here with the authority it was made for: that site's Host, or X-Forwarded-Host behind a
  // trusted proxy. The signature is valid, just not for this site, and this site's nonce cache
  // never saw it (ADR-023). Control: the same agent signing for this site is VERIFIED.
  async "cross-site-replay"({ variant, other = "shop-a.example", method = "POST", body = '{"sku":1}' }, w) {
    const control = ok(await deps.signed({ key: w.agent, method, body }));
    const elsewhere = (authority, p = "/checkout/1", extra = {}) => deps.signed({ key: w.agent, method, body, url: `https://${authority}${p}`, ...extra });
    if (variant === "host-of-origin-site") return [control, bad(await elsewhere(other))];
    if (variant === "other-port") return [control, bad(await elsewhere(`${new URL(SITE).hostname}:8443`))];
    if (variant === "sibling-subdomain") return [control, bad(await elsewhere(`api.${new URL(SITE).hostname}`))];
    if (variant === "get-onto-critical-route") {
      // A GET covers no @path: one the agent made to /products at the other site lands on /checkout here.
      const get = await deps.signed({ key: w.agent, url: `https://${other}/products` });
      return [ok(await deps.signed({ key: w.agent })), bad(retarget(get, `https://${other}/checkout/9`))];
    }
    if (variant === "forwarded-host" || variant === "forwarded-host-untrusted") {
      const mw = await nodeGate(w, { trustProxy: variant === "forwarded-host" });
      const req = await elsewhere(other);
      const xfh = withFields(req, { host: new URL(SITE).host, "x-forwarded-host": other, "x-forwarded-proto": "https" });
      return [{ node: mw, req: incoming(await deps.signed({ key: w.agent, method, body }), "/checkout/1"), atS: 0, expect: "verified" },
        { node: mw, req: incoming(xfh, "/checkout/1"), atS: 0, expect: "rejected" }];
    }
    if (variant === "absolute-form-other-authority") {
      const mw = await nodeGate(w);
      return [{ node: mw, req: incoming(await deps.signed({ key: w.agent, method, body }), "/checkout/1"), atS: 0, expect: "verified" },
        { node: mw, req: incoming(await elsewhere(other), `https://${other}/checkout/1`), atS: 0, expect: "rejected" }];
    }
    if (variant === "unpinned-gate") {
      // A Gate with no `authorities`: verification still works where nothing is granted (P0),
      // but it must not let a valid signature through a Pressure 2 route (fail_mode, default closed).
      const unpinned = await deps.harness({ agentKeys: [w.agent, w.sibling], registry: w.registry, now: () => w.t, resolver: { fetch: w.fetch }, authorities: null });
      return [{ gate: unpinned, req: await deps.signed({ key: w.agent, url: `${SITE}/products` }), atS: 0, expect: "verified" },
        { gate: unpinned, req: await elsewhere(other), atS: 0, expect: "rejected" }];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Flood the replay cache with valid signatures of one's own until the victim's nonce is evicted,
  // then replay the victim's captured request inside its validity. Modelled on a Gate with a
  // 40-entry cache (the logic does not depend on the size; the default is 100,000). `flood` steps
  // are the attacker's own traffic and may land in any class; the victim signing afresh after a
  // single-owner flood must still be VERIFIED (the flooder is stopped, not the victim).
  // `hour-long-*`: the same with hour-long signatures (spec §10.4 accepts them with a nonce), whose
  // nonces live an hour. Many owners fill the cache with them: the victim's captured nonce is never
  // pushed out (a replay half an hour later is still a replay), and while the cache is full a new
  // hour-long signature is not VERIFIED (it could not be remembered), so it is refused on Pressure 2.
  async "nonce-flood"({ variant, flood = 60, delayS = 1 }, w) {
    const gate = await deps.harness({ agentKeys: [w.agent], attackerKeys: [w.attacker], registry: w.registry, now: () => w.t, resolver: { fetch: w.fetch }, nonceCache: { maxEntries: 40 } });
    const hour = variant.startsWith("hour-long");
    const sign = (o) => deps.signed({ ...o, ...(hour ? { lifetime: 3600 } : {}) });
    const captured = await sign({ key: w.agent, ...(variant === "nonce-less-victim" ? { nonce: null } : {}) });
    const steps = [{ gate, req: captured, atS: 0, expect: "verified" }];
    let floodKeys = [{ key: w.attacker, agent: ATTACKER }];
    if (variant === "many-keys-one-directory" || variant === "many-directories" || hour) {
      const keys = await Promise.all(Array.from({ length: 12 }, () => deps.keypair()));
      if (variant === "many-keys-one-directory" && !hour) {
        await gate.resolver.prime({ type: "directory", uri: "https://swarm.example" }, { keys: keys.map((k) => ({ ...k.publicJwk, use: "sig" })) });
        floodKeys = keys.map((key) => ({ key, agent: "https://swarm.example" }));
      } else {
        floodKeys = [];
        for (const [i, key] of keys.entries()) {
          await gate.resolver.prime({ type: "directory", uri: `https://s${i}.swarm.example` }, { keys: [{ ...key.publicJwk, use: "sig" }] });
          floodKeys.push({ key, agent: `https://s${i}.swarm.example` });
        }
      }
    }
    for (let i = 0; i < flood; i++) steps.push({ gate, req: await sign(floodKeys[i % floodKeys.length]), atS: 0, expect: "flood" });
    if (variant === "hour-long-full") return [...steps, { gate, req: await sign({ key: w.agent }), atS: 0, expect: "rejected" }];
    if (variant === "hour-long-replay") return [...steps, { gate, req: captured, atS: 1800, expect: "rejected" }];
    // Many independent owners can fill the cache (then nobody new is VERIFIED: a documented limit);
    // one owner, however many keys, must not lock the victim out.
    if (variant !== "many-directories") steps.push({ gate, req: await deps.signed({ key: w.agent }), atS: 0, expect: "verified" });
    steps.push({ gate, req: captured, atS: variant === "replay-in-skew-tail" ? 60 + 20 : delayS, expect: "rejected" });
    return steps;
  },
  // Abuse the ±30s clock-skew allowance or the lifetime rules.
  async "clock-skew"({ variant }, w) {
    if (variant === "replay-in-skew-tail") {
      const req = await deps.signed({ key: w.agent });
      return [ok(req), bad(req, 60 + 20)];
    }
    if (variant === "future-created") return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: w.agent, created: NOW_S + 3600 }))];
    // A Gate accepts up to an hour, and past 60 s only with a nonce (spec §10.4).
    if (variant === "long-lived") return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: w.agent, lifetime: 3601 }))];
    if (variant === "nonceless-long-lived") return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: w.agent, lifetime: 3600, nonce: null }))];
    if (variant === "replay-long-lived-late") {
      const req = await deps.signed({ key: w.agent, lifetime: 3600 });
      return [ok(req), bad(req, 1800)];
    }
    if (variant === "pre-dated-long-lived") return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: w.agent, created: NOW_S - 3600, expires: NOW_S + 30 }))];
    if (variant === "just-past-skew") return [ok(await deps.signed({ key: w.agent })), bad(await deps.signed({ key: w.agent, created: NOW_S - 95, expires: NOW_S - 35 }))];
    throw new Error(`unknown variant ${variant}`);
  },
};
