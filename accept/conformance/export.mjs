#!/usr/bin/env node
// The conformance suite as data (GATE-10, for GATE-9): every GATE-7 attack and the WG test vectors
// written out as concrete requests, so a Gate in any language runs the same cases.
//
//   node accept/conformance/export.mjs          write accept/conformance/vectors.json
//
// Each GATE-7 corpus entry runs through its family (accept/attacks/families.mjs) against real
// Gates, with the Gate builder swapped for one that records what each Gate was given. Written out:
//   world     the Registry's public key and issuer, the documents served at URLs (CIMD cards, …)
//   gates     per Gate: which adapter (core | node), its authorities, trust_proxy, nonce-cache
//             size, and the key directories it knows (public keys only)
//   steps     in order: the request (a core RequestDescriptor, or a raw request as a Node server
//             receives it), when it arrives (seconds after `now`), what it must be (verified |
//             rejected | human | denied | flood), and what the reference Gate answered.
// Keys and nonces are seeded from the case id, and time is fixed, so an export is reproducible
// byte for byte: GATE-10 re-exports and compares, and adding an attack adds just its case. The
// seeded keys are throwaway test keys; no private key is ever written.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FAMILIES, deps, world as makeWorld, throughNode } from "../attacks/families.mjs";
import { AGENT, ATTACKER, SITE, NOW_MS, ROUTES, REGISTRY_ISS } from "../../packages/gate-core/test/support.mjs";
import { thumbprint } from "../../packages/gate-core/src/thumbprint.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../..");
const ATTACKS = path.join(ROOT, "accept/attacks");
export const VECTORS = path.join(DIR, "vectors.json");

const publicOf = (k) => ({ kty: "OKP", crv: "Ed25519", x: k.x, ...(k.kid ? { kid: k.kid } : {}), ...(k.use ? { use: k.use } : {}) });

// ── determinism: every key and nonce a case uses comes from its id and a counter ─────────────
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex"); // RFC 8410 PrivateKeyInfo prefix for a 32-byte seed
const seed = (id, what, n, len = 32) => {
  let out = Buffer.alloc(0);
  for (let i = 0; out.length < len; i++) out = Buffer.concat([out, createHash("sha256").update(`ludion-conformance|${id}|${what}|${n}|${i}`).digest()]);
  return out.subarray(0, len);
};
/** support.mjs keypair(), from a seed. */
async function seededKeypair(bytes) {
  const pk = await crypto.subtle.importKey("pkcs8", Buffer.concat([PKCS8_ED25519, bytes]), { name: "Ed25519" }, true, ["sign"]);
  const { x, d } = await crypto.subtle.exportKey("jwk", pk);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x };
  const kid = thumbprint(publicJwk);
  return { kid, publicJwk: { ...publicJwk, kid }, privateJwk: { ...publicJwk, d, kid }, privateKey: pk };
}
function seededDeps(id, original) {
  let keys = 0, nonces = 0;
  return {
    keypair: () => seededKeypair(seed(id, "key", keys++)),
    signed: (o) => original.signed({ nonce: seed(id, "nonce", nonces++, 64).toString("base64"), ...o }),
  };
}

/** The Gate builder families call, recording what each Gate was given and every directory primed into it. */
function recordingHarness(original) {
  return async (opts = {}) => {
    const gate = await original(opts);
    const directories = [];
    if (opts.agentKeys?.length) directories.push({ uri: AGENT, keys: opts.agentKeys.map((k) => ({ ...publicOf(k.publicJwk), use: "sig" })) });
    if (opts.attackerKeys?.length) directories.push({ uri: ATTACKER, keys: opts.attackerKeys.map((k) => ({ ...publicOf(k.publicJwk), use: "sig" })) });
    const prime = gate.resolver.prime.bind(gate.resolver);
    gate.resolver.prime = async (candidate, doc) => {
      directories.push({ uri: candidate.uri, keys: doc.keys.map(publicOf) });
      return prime(candidate, doc);
    };
    gate.conformance = {
      adapter: "core",
      authorities: opts.authorities === undefined ? [new URL(SITE).host] : opts.authorities,
      ...(opts.nonceCache ? { nonceCache: opts.nonceCache } : {}),
      directories,
    };
    return gate;
  };
}

function serializeRequest(s) {
  if (s.node) {
    const r = s.req;
    return { raw: { method: r.method, target: r.url, rawHeaders: r.rawHeaders, tls: !!r.socket?.encrypted, remoteAddress: r.socket?.remoteAddress } };
  }
  return { core: { method: s.req.method, targetUri: s.req.targetUri, fields: s.req.fields.map((f) => ({ name: f.name, value: f.value })) } };
}

/** One corpus entry → a case, run against the real Gates as it is recorded. */
async function exportAttack(spec) {
  const w = await makeWorld();
  const steps = await FAMILIES[spec.family](spec.params ?? {}, w);
  const gates = new Map(); // live Gate or middleware → id
  const gateSpecs = {};
  const idOf = (s) => {
    const live = s.node ?? s.gate ?? w.gate;
    if (!gates.has(live)) {
      const id = live === w.gate ? "main" : `g${gates.size}`;
      gates.set(live, id);
      gateSpecs[id] = s.node
        ? { adapter: "node", authorities: [new URL(SITE).host], ...(s.node.conformance.options.trustProxy ? { trustProxy: true } : {}),
          directories: [{ uri: AGENT, keys: [w.agent, w.sibling].map((k) => ({ ...publicOf(k.publicJwk), use: "sig" })) }, { uri: ATTACKER, keys: [{ ...publicOf(w.attacker.publicJwk), use: "sig" }] }] }
        : structuredClone(live.conformance);
    }
    return gates.get(live);
  };
  const out = [];
  for (const s of steps) {
    const gate = idOf(s);
    w.t = NOW_MS + s.atS * 1000;
    const res = s.node ? await throughNode(s.node, s.req) : { result: await (s.gate ?? w.gate).inspect(s.req) };
    const r = res.result;
    out.push({
      gate, atS: s.atS, expect: s.expect, ...serializeRequest(s),
      reference: { class: r.cls.class, action: r.decision.action, ...(r.decision.error ? { error: r.decision.error } : {}), ...(s.node ? { reachedApp: res.reachedApp } : {}) },
    });
  }
  // Directories a Gate was given after its steps were recorded (priming happens before use) are already in.
  return {
    id: spec.id, source: "GATE-7", family: spec.family, title: spec.title, params: spec.params ?? {},
    world: {
      registry: { issuer: REGISTRY_ISS, keys: [publicOf(w.registry.publicJwk)] },
      documents: [...w.docs].map(([url, d]) => ({ url, contentType: d.type ?? "application/json", body: d.body })),
    },
    gates: gateSpecs, steps: out,
  };
}

/** draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.2.1 (Ed25519, the RFC 9421 B.1.4 key). */
function wgVectors() {
  const E21 = {
    method: "GET", targetUri: "https://example.com/", fields: [
      { name: "signature-agent", value: 'agent2="https://signature-agent.test"' },
      { name: "signature-input", value: 'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"' },
      { name: "signature", value: "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:" },
    ],
  };
  const directory = { uri: "https://signature-agent.test", keys: [{ kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs", use: "sig" }] };
  const gate = { adapter: "core", authorities: ["example.com"], directories: [directory] };
  const tampered = { ...E21, fields: E21.fields.map((f) => (f.name === "signature" ? { ...f, value: f.value.replace("RdNF", "RdNG") } : f)) };
  const world = { registry: { issuer: REGISTRY_ISS, keys: [] }, documents: [] };
  const reference = { keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U", identifier: "https://signature-agent.test" };
  // The vector's expires is decades away. Its signature is checked as RFC 9421 with the lifetime
  // left to the caller (`signature` steps); through a Gate, which holds every signature to 60 s
  // (spec §10.4), the same request is refused. All at created + 1 s.
  return [
    { id: "wg-e2-1--signature-verifies", source: "STD-1", title: "WG -00 App. E.2.1: the signature verifies (keyid, directory identifier)", now: 1735689601000, world, gates: {},
      steps: [{ atS: 0, expect: "valid", signature: { request: E21, directories: [directory] }, reference }] },
    { id: "wg-e2-1--one-flipped-byte", source: "STD-1", title: "WG -00 App. E.2.1 with one signature byte flipped does not verify", now: 1735689601000, world, gates: {},
      steps: [{ atS: 0, expect: "invalid", signature: { request: tampered, directories: [directory] } }] },
    { id: "wg-e2-1--gate-holds-to-60s", source: "STD-1", title: "WG -00 App. E.2.1 through a Gate: valid, but alive for decades, so SPOOFED (spec §10.4)", now: 1735689601000, world, gates: { main: gate },
      steps: [{ gate: "main", atS: 0, expect: "rejected", core: E21, reference: { class: "SPOOFED", action: "allow" } }] },
  ];
}

export async function exportAll() {
  const files = fs.readdirSync(ATTACKS).filter((f) => f.endsWith(".json")).sort();
  const cases = [];
  const original = { ...deps };
  try {
    deps.harness = recordingHarness(original.harness);
    for (const f of files) {
      const spec = JSON.parse(fs.readFileSync(path.join(ATTACKS, f), "utf8"));
      Object.assign(deps, seededDeps(spec.id, original));
      cases.push(await exportAttack(spec));
    }
  } finally { Object.assign(deps, original); }
  return {
    note: "Ludion Gate conformance vectors: GATE-7's attack corpus and the WG test vectors as concrete requests. Written by accept/conformance/export.mjs; checked by GATE-10; read by every Gate implementation (GATE-9). See accept/conformance/README.md.",
    version: 1,
    defaults: { now: NOW_MS, siteId: "site-test", pressure: 0, routes: ROUTES, site: SITE },
    cases: [...wgVectors(), ...cases],
  };
}

/** The file's exact text. */
export async function exportText() {
  const text = `${JSON.stringify(await exportAll(), null, 1)}\n`;
  if (/"d"\s*:/.test(text)) throw new Error("a private key member would be written");
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await exportText();
  const v = JSON.parse(text);
  fs.writeFileSync(VECTORS, text);
  console.log(`wrote ${path.relative(ROOT, VECTORS)}: ${v.cases.length} cases, ${v.cases.reduce((n, c) => n + c.steps.length, 0)} steps, ${(text.length / 1024).toFixed(0)} KiB`);
}
