#!/usr/bin/env node
// GATE-7 runner. The corpus is every accept/attacks/*.json: data naming an attack `family`
// and its `params`. Each attack runs in a fresh world (victim agent with a sibling key and a
// Staple, an attacker with their own directory and Staple, a pinned Registry, a Gate at P0 with
// Pressure-2 routes). A family yields steps: `verified` steps are controls proving the setup is
// honest; `rejected` steps are the attack and must be refused (not VERIFIED, no Staple standing,
// denied on the P2 route). Families that attack how a raw request reaches the app (route-evasion)
// run their steps through the real @ludion/gate-node adapter, where `rejected` also means the
// request never reached the app; `human` steps must reach it untouched, and `denied` controls
// prove the route is protected when spelled plainly. Exit 1 if any attack gets through, the
// corpus is empty, a required family is missing, or an attack that exists on the base branch was
// deleted (the corpus only grows).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { component } from "http-message-sig";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey, originForm } from "@ludion/gate-core";
import { keypair, signed, harness, staple, withFields, fieldOf, retarget, rejected, AGENT, ATTACKER, SITE, NOW_MS, NOW_S, ROUTES, REGISTRY_ISS } from "../../packages/gate-core/test/support.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../..");
const REQUIRED = ["replay", "staple-swap", "cnf-mismatch", "strip-signature", "key-confusion", "label-confusion", "omitted-components", "clock-skew", "route-evasion", "cross-site-replay", "nonce-flood"];
const UAS = {
  human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  suspected: "python-requests/2.32.3",
  declared: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
};
const VICTIM_DIVER = "dvr-victimvictimvic2", ATTACKER_DIVER = "dvr-attackerattacke2";

async function world() {
  const [agent, sibling, attacker, registry] = await Promise.all([keypair(), keypair(), keypair(), keypair()]);
  const w = { t: NOW_MS, agent, sibling, attacker, registry, docs: new Map() };
  const fetch = async (url) => {
    const doc = w.docs.get(String(url));
    return doc ? new Response(JSON.stringify(doc.body), { status: 200, headers: { "content-type": doc.type ?? "application/json" } }) : new Response("", { status: 404 });
  };
  w.fetch = fetch;
  w.gate = await harness({ agentKeys: [agent, sibling], attackerKeys: [attacker], registry, now: () => w.t, resolver: { fetch } });
  w.victimStaple = await staple(registry, { sub: VICTIM_DIVER, jkt: agent.kid, depth: 2 });
  w.attackerStaple = await staple(registry, { sub: ATTACKER_DIVER, jkt: attacker.kid, depth: 1 });
  return w;
}

/**
 * The same world behind the real Node adapter (same routes, keys and Registry), built on first
 * use per adapter option set (e.g. `{ trustProxy: true }`).
 */
async function nodeGate(w, opts = {}) {
  const k = JSON.stringify(opts);
  w.nodes ??= new Map();
  if (w.nodes.has(k)) return w.nodes.get(k);
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({ siteId: "site-test", siteKey: siteKey.privateJwk, pressure: 0, now: () => w.t, routes: ROUTES,
    authorities: [new URL(SITE).host], registryKeys: { keys: [w.registry.publicJwk] }, registryIssuer: REGISTRY_ISS, resolver: { fetch: w.fetch }, ...opts });
  await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [w.agent, w.sibling].map((k) => ({ ...k.publicJwk, use: "sig" })) });
  await mw.gate.resolver.prime({ type: "directory", uri: ATTACKER }, { keys: [{ ...w.attacker.publicJwk, use: "sig" }] });
  w.nodes.set(k, mw);
  return mw;
}

/** An IncomingMessage as Node hands it to the app: the raw request-target, raw headers, a TLS socket. */
function incoming(desc, target) {
  const fields = desc.fields.some((f) => f.name.toLowerCase() === "host") ? desc.fields : [{ name: "host", value: new URL(SITE).host }, ...desc.fields];
  const headers = {};
  for (const f of fields) { const k = f.name.toLowerCase(); headers[k] = k in headers ? `${headers[k]}, ${f.value}` : f.value; }
  return { method: desc.method, url: target, rawHeaders: fields.flatMap((f) => [f.name, f.value]), headers, socket: { encrypted: true, remoteAddress: "203.0.113.7" } };
}

/** Run one request through the adapter: did it reach the app, and what did the Gate decide? */
function throughNode(mw, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; },
      end() { resolve({ reachedApp: false, status: this.statusCode, headers: this.h, result: req.ludion }); } };
    Promise.resolve(mw(req, res, () => resolve({ reachedApp: true, status: 200, headers: res.h, result: req.ludion }))).catch(reject);
  });
}

const url = (p) => `${SITE}${p ?? "/checkout/1"}`;
const covered = (list) => list.map((c) => (typeof c === "string" ? c : component(c.name, c.params ?? {})));
const stapled = (key, s, extra = {}) => signed({ key, extraComponents: ["ludion-staple"], ...extra, headers: { ...extra.headers, "ludion-staple": s } });
const ok = (req, atS = 0) => ({ req, atS, expect: "verified" });
const bad = (req, atS = 0) => ({ req, atS, expect: "rejected" });

const FAMILIES = {
  // Resend a captured signed request. `delayS`: when the copy arrives; `nonce: false`: the
  // signer did not send a nonce (third-party signers may not); `replayPath`: send the captured
  // fields to another path on the same authority (a GET signature does not cover @path).
  async replay({ method = "GET", path: p, body, delayS = 1, nonce = true, replayPath }, w) {
    const req = await signed({ key: w.agent, method, url: url(p), body, ...(nonce ? {} : { nonce: null }) });
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
      const mine = await signed({ key: w.attacker, agent: ATTACKER });
      return [ok(await signed({ key: w.attacker, agent: ATTACKER })), bad(withFields(mine, { "ludion-staple": w.victimStaple }))];
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
  // A Staple bound (cnf.jkt) to one key presented under a signature by another key.
  async "cnf-mismatch"({ variant }, w) {
    if (variant === "sibling-key") return [ok(await signed({ key: w.sibling })), bad(await stapled(w.sibling, w.victimStaple))];
    if (variant === "attacker-key") return [ok(await signed({ key: w.attacker, agent: ATTACKER })), bad(await stapled(w.attacker, w.victimStaple, { agent: ATTACKER }))];
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
    if (variant === "claim-victim-directory") return [ok(await signed({ key: a, agent: ATTACKER })), bad(await signed({ key: a, agent: AGENT }))];
    if (variant === "warm-cache-then-claim") {
      return [ok(await signed({ key: a, agent: ATTACKER })), ok(await signed({ key: a, agent: ATTACKER })), bad(await signed({ key: a, agent: AGENT }))];
    }
    if (variant === "multi-member-cover-victim") {
      const agentHeader = `v="${AGENT}", x="${ATTACKER}"`;
      return [ok(await signed({ key: a, agentHeader, agentKey: "x" })), bad(await signed({ key: a, agentHeader, agentKey: "v" }))];
    }
    if (variant === "cimd-card-claims-victim-client-id") {
      w.docs.set(`${ATTACKER}/card`, { body: { client_id: `${ATTACKER}/card`, client_name: "A", jwks: { keys: [{ ...a.publicJwk, use: "sig" }] } } });
      w.docs.set(`${ATTACKER}/lying-card`, { body: { client_id: `${AGENT}/card`, client_name: "A", jwks: { keys: [{ ...a.publicJwk, use: "sig" }] } } });
      return [ok(await signed({ key: a, agentHeader: `sig1="${ATTACKER}/card";type=cimd` })),
        bad(await signed({ key: a, agentHeader: `sig1="${ATTACKER}/lying-card";type=cimd` }))];
    }
    if (variant === "http-directory") {
      w.docs.set(`http://agent.example/.well-known/http-message-signatures-directory`, { body: { keys: [{ ...a.publicJwk, use: "sig" }] } });
      return [ok(await signed({ key: w.agent })), bad(await signed({ key: a, agent: "http://agent.example" }))];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Confuse which signature, label or Signature-Agent member the Gate evaluates.
  async "label-confusion"({ variant }, w) {
    if (variant === "append-own-signature") {
      const agentHeader = `sig1="${AGENT}", sig2="${ATTACKER}"`;
      const victim = await signed({ key: w.agent, agentHeader });
      const mine = await signed({ key: w.attacker, agentHeader, label: "sig2", agentKey: "sig2" });
      const both = withFields(victim, {
        "signature-input": `${fieldOf(victim, "signature-input")}, ${fieldOf(mine, "signature-input")}`,
        signature: `${fieldOf(victim, "signature")}, ${fieldOf(mine, "signature")}`,
      });
      return [ok(await signed({ key: w.agent, agentHeader })), bad(both)];
    }
    if (variant === "extra-input-label") {
      const req = await signed({ key: w.agent });
      const extra = fieldOf(await signed({ key: w.attacker, agent: ATTACKER, label: "sig2", agentHeader: `sig2="${ATTACKER}"` }), "signature-input");
      return [ok(await signed({ key: w.agent })), bad(withFields(req, { "signature-input": `${fieldOf(req, "signature-input")}, ${extra}` }))];
    }
    if (variant === "cross-member-label") {
      const agentHeader = `sig1="${ATTACKER}", sig2="${AGENT}"`;
      return [ok(await signed({ key: w.attacker, agentHeader, agentKey: "sig1" })), bad(await signed({ key: w.attacker, agentHeader, agentKey: "sig2" }))];
    }
    if (variant === "duplicate-member") {
      return [ok(await signed({ key: w.attacker, agent: ATTACKER })),
        bad(await signed({ key: w.attacker, agentHeader: `sig1="${ATTACKER}", sig1="${AGENT}"` }))];
    }
    if (variant === "split-header-lines") {
      const req = await signed({ key: w.attacker, agentHeader: `sig1="${ATTACKER}", sig1="${AGENT}"` });
      const fields = req.fields.filter((f) => f.name !== "signature-agent");
      fields.unshift({ name: "signature-agent", value: `sig1="${ATTACKER}"` }, { name: "signature-agent", value: `sig1="${AGENT}"` });
      return [ok(await signed({ key: w.attacker, agent: ATTACKER })), bad({ ...req, fields })];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // A state-changing request whose signature leaves out what binds it (spec §10.4). The control
  // is the same method signed the way the Diver does it, with a body and its Content-Digest.
  async "omitted-components"({ method = "POST", cover, body, headers = {} }, w) {
    const control = await signed({ key: w.agent, method, body: '{"sku":1}' });
    return [ok(control), bad(await signed({ key: w.agent, method, body, headers, components: cover ? covered(cover) : undefined }))];
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
    const honest = incoming(await signed({ key: w.agent, method, url: url(originForm(target)) }), target);
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
    const control = ok(await signed({ key: w.agent, method, body }));
    const elsewhere = (authority, p = "/checkout/1", extra = {}) => signed({ key: w.agent, method, body, url: `https://${authority}${p}`, ...extra });
    if (variant === "host-of-origin-site") return [control, bad(await elsewhere(other))];
    if (variant === "other-port") return [control, bad(await elsewhere(`${new URL(SITE).hostname}:8443`))];
    if (variant === "sibling-subdomain") return [control, bad(await elsewhere(`api.${new URL(SITE).hostname}`))];
    if (variant === "get-onto-critical-route") {
      // A GET covers no @path: one the agent made to /products at the other site lands on /checkout here.
      const get = await signed({ key: w.agent, url: `https://${other}/products` });
      return [ok(await signed({ key: w.agent })), bad(retarget(get, `https://${other}/checkout/9`))];
    }
    if (variant === "forwarded-host" || variant === "forwarded-host-untrusted") {
      const mw = await nodeGate(w, { trustProxy: variant === "forwarded-host" });
      const req = await elsewhere(other);
      const xfh = withFields(req, { host: new URL(SITE).host, "x-forwarded-host": other, "x-forwarded-proto": "https" });
      return [{ node: mw, req: incoming(await signed({ key: w.agent, method, body }), "/checkout/1"), atS: 0, expect: "verified" },
        { node: mw, req: incoming(xfh, "/checkout/1"), atS: 0, expect: "rejected" }];
    }
    if (variant === "absolute-form-other-authority") {
      const mw = await nodeGate(w);
      return [{ node: mw, req: incoming(await signed({ key: w.agent, method, body }), "/checkout/1"), atS: 0, expect: "verified" },
        { node: mw, req: incoming(await elsewhere(other), `https://${other}/checkout/1`), atS: 0, expect: "rejected" }];
    }
    if (variant === "unpinned-gate") {
      // A Gate with no `authorities`: verification still works where nothing is granted (P0),
      // but it must not let a valid signature through a Pressure 2 route (fail_mode, default closed).
      const unpinned = await harness({ agentKeys: [w.agent, w.sibling], registry: w.registry, now: () => w.t, resolver: { fetch: w.fetch }, authorities: null });
      return [{ gate: unpinned, req: await signed({ key: w.agent, url: `${SITE}/products` }), atS: 0, expect: "verified" },
        { gate: unpinned, req: await elsewhere(other), atS: 0, expect: "rejected" }];
    }
    throw new Error(`unknown variant ${variant}`);
  },
  // Flood the replay cache with valid signatures of one's own until the victim's nonce is evicted,
  // then replay the victim's captured request inside its validity. Modelled on a Gate with a
  // 40-entry cache (the logic does not depend on the size; the default is 100,000). `flood` steps
  // are the attacker's own traffic and may land in any class; the victim signing afresh after a
  // single-owner flood must still be VERIFIED (the flooder is stopped, not the victim).
  async "nonce-flood"({ variant, flood = 60, delayS = 1 }, w) {
    const gate = await harness({ agentKeys: [w.agent], attackerKeys: [w.attacker], registry: w.registry, now: () => w.t, resolver: { fetch: w.fetch }, nonceCache: { maxEntries: 40 } });
    const captured = await signed({ key: w.agent, ...(variant === "nonce-less-victim" ? { nonce: null } : {}) });
    const steps = [{ gate, req: captured, atS: 0, expect: "verified" }];
    let floodKeys = [{ key: w.attacker, agent: ATTACKER }];
    if (variant === "many-keys-one-directory" || variant === "many-directories") {
      const keys = await Promise.all(Array.from({ length: 12 }, () => keypair()));
      if (variant === "many-keys-one-directory") {
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
    for (let i = 0; i < flood; i++) steps.push({ gate, req: await signed(floodKeys[i % floodKeys.length]), atS: 0, expect: "flood" });
    // Many independent owners can fill the cache (then nobody new is VERIFIED: a documented limit);
    // one owner, however many keys, must not lock the victim out.
    if (variant !== "many-directories") steps.push({ gate, req: await signed({ key: w.agent }), atS: 0, expect: "verified" });
    steps.push({ gate, req: captured, atS: variant === "replay-in-skew-tail" ? 60 + 20 : delayS, expect: "rejected" });
    return steps;
  },
  // Abuse the ±30s clock-skew allowance or the lifetime rules.
  async "clock-skew"({ variant }, w) {
    if (variant === "replay-in-skew-tail") {
      const req = await signed({ key: w.agent });
      return [ok(req), bad(req, 60 + 20)];
    }
    if (variant === "future-created") return [ok(await signed({ key: w.agent })), bad(await signed({ key: w.agent, created: NOW_S + 3600 }))];
    if (variant === "long-lived") return [ok(await signed({ key: w.agent })), bad(await signed({ key: w.agent, lifetime: 3600 }))];
    if (variant === "pre-dated-long-lived") return [ok(await signed({ key: w.agent })), bad(await signed({ key: w.agent, created: NOW_S - 3600, expires: NOW_S + 30 }))];
    if (variant === "just-past-skew") return [ok(await signed({ key: w.agent })), bad(await signed({ key: w.agent, created: NOW_S - 95, expires: NOW_S - 35 }))];
    throw new Error(`unknown variant ${variant}`);
  },
};

function baseCorpus() {
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let ref = "HEAD";
  try { ref = git("merge-base", "HEAD", "origin/main"); } catch { /* no remote: compare with the last commit */ }
  try { return git("ls-tree", "--name-only", `${ref}:accept/attacks/`).split("\n").filter((f) => f.endsWith(".json")); } catch { return []; }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const problems = [];
if (!files.length) problems.push("corpus is empty");
const deleted = baseCorpus().filter((f) => !files.includes(f));
if (deleted.length) problems.push(`corpus shrank; deleted: ${deleted.join(", ")}`);
const families = new Set();

for (const f of files) {
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { problems.push(`${f}: not JSON`); continue; }
  const id = f.replace(/\.json$/, "");
  if (spec.id !== id) { problems.push(`${f}: id ${spec.id} must equal the file name`); continue; }
  if (!FAMILIES[spec.family]) { problems.push(`${id}: unknown family ${spec.family}`); continue; }
  if (!spec.title) { problems.push(`${id}: needs a title`); continue; }
  families.add(spec.family);
  try {
    const w = await world();
    const steps = await FAMILIES[spec.family](spec.params ?? {}, w);
    if (!steps.some((s) => s.expect === "rejected")) throw new Error("family produced no attack step");
    const seen = [];
    for (const [i, s] of steps.entries()) {
      w.t = NOW_MS + s.atS * 1000;
      const out = s.node ? await throughNode(s.node, s.req) : null;
      const r = out ? out.result : await (s.gate ?? w.gate).inspect(s.req);
      seen.push(r.cls.class);
      if (s.expect === "verified" && r.cls.class !== "VERIFIED") throw new Error(`control step ${i} not VERIFIED (${r.cls.class} ${r.cls.reason ?? ""} ${r.cls.detail ?? ""}) — the attack proves nothing`);
      if (s.expect === "human" && (!out?.reachedApp || out.headers["ludion-error"])) throw new Error(`human step ${i} was touched (${out?.status} ${out?.headers["ludion-error"] ?? ""})`);
      if (s.expect === "denied" && (!out || out.reachedApp || ![401, 403].includes(out.status))) throw new Error(`control step ${i}: the plainly spelled route is not protected — the attack proves nothing`);
      if (!["verified", "human", "denied", "rejected", "flood"].includes(s.expect)) throw new Error(`step ${i}: unknown expectation ${s.expect}`);
      if (s.expect === "rejected") {
        const p = rejected(r, { victim: AGENT });
        if (out && (out.reachedApp || !out.headers["ludion-error"])) p.push(`reached the app (route ${r.route?.template ?? "none"}, Pressure ${r.route?.pressure})`);
        if (p.length) throw new Error(`GOT THROUGH at step ${i}: ${p.join("; ")}`);
      }
    }
    console.log(`ok   ${id}  ${seen.join(" → ")}`);
  } catch (e) { problems.push(`${id}: ${e.message}`); }
}
for (const fam of REQUIRED) if (!families.has(fam)) problems.push(`required attack family missing from the corpus: ${fam}`);

for (const p of problems) console.log(`FAIL ${p}`);
console.log(`\n${files.length} attacks, ${families.size} families, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
