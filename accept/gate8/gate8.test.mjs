// GATE-8 (+): real. A request that a third party's production agent really sent, recorded with
// where it was captured, when, and the directory that published its key, is VERIFIED by the Gate
// as that agent. Each fixture (accept/gate8/real/*.json) is first shown to be what its sources hold
// (the archive's digests) and to be really signed (on a signature base built here, apart from the
// Gate's libraries). Then the Gate sees the request at the moment it arrived, with the directory
// served as it was then, and must name the agent. Pair (GATE-7): the same request tampered,
// replayed, late, for another site, or against today's directory is never VERIFIED.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { createGate, generateSiteKey } from "../../packages/gate-core/src/index.mjs";
import { thumbprint } from "../../packages/gate-core/src/thumbprint.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "real");
const FIXTURES = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));

/** The Wayback Machine's CDX digest: SHA-1 of the payload in RFC 4648 base32. */
function cdxDigest(text) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, v = 0, out = "";
  for (const b of createHash("sha1").update(text, "utf8").digest()) {
    v = ((v << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + A[(v << (5 - bits)) & 31] : out;
}

const header = (fx, name) => fx.request.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v.trim()).join(", ") || undefined;
const withHeader = (fx, name, value) => ({ ...fx, request: { ...fx.request, headers: fx.request.headers.map(([n, v]) => [n, n.toLowerCase() === name ? value : v]) } });
const withTarget = (fx, target) => ({ ...fx, request: { ...fx.request, target } });
const withMethod = (fx, method) => ({ ...fx, request: { ...fx.request, method } });

/**
 * The RFC 9421 §2.5 signature base of the fixture's signature, built here from the fields as
 * captured. Only what real fixtures need: bare derived components and bare fields; anything else
 * is refused rather than guessed.
 */
function signatureBase(fx) {
  const input = header(fx, "signature-input");
  const m = /^([a-z*][a-z0-9_.*-]*)=\(([^)]*)\)(.*)$/.exec(input ?? "");
  if (!m) throw new Error(`${fx.id}: Signature-Input is not one bare member`);
  const [, label, list, params] = m;
  const url = new URL(fx.request.target);
  const lines = [];
  for (const item of list.split(" ").filter(Boolean)) {
    const c = /^"([^"]+)"$/.exec(item)?.[1];
    if (!c) throw new Error(`${fx.id}: component ${item} has parameters; extend signatureBase before using it`);
    const value = c === "@authority" ? url.host.toLowerCase() : c === "@method" ? fx.request.method.toUpperCase() : c === "@path" ? url.pathname
      : c.startsWith("@") ? undefined : header(fx, c);
    if (value === undefined) throw new Error(`${fx.id}: cannot build component ${c}`);
    lines.push(`"${c}": ${value}`);
  }
  lines.push(`"@signature-params": (${list})${params}`);
  const sig = new RegExp(`^${label}=:([A-Za-z0-9+/=]+):$`).exec(header(fx, "signature") ?? "")?.[1];
  if (!sig) throw new Error(`${fx.id}: no Signature member ${label}`);
  const keyid = /;keyid="([^"]+)"/.exec(params)?.[1];
  const created = Number(/;created=(\d+)/.exec(params)?.[1]);
  const expires = Number(/;expires=(\d+)/.exec(params)?.[1]);
  return { base: lines.join("\n"), signature: Uint8Array.from(Buffer.from(sig, "base64")), keyid, created, expires };
}

async function signedByDirectoryKey(fx, directoryBody = fx.directory.body) {
  const s = signatureBase(fx);
  const jwk = JSON.parse(directoryBody).keys.find((k) => thumbprint({ kty: k.kty, crv: k.crv, x: k.x }) === s.keyid);
  if (!jwk) return false;
  const v = await verifierFromJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  return (await v.verify(new TextEncoder().encode(s.base), s.signature)) === true;
}

/** The Gate a site would run, with the directory served as it was then. `routes`: the target at Pressure 2. */
async function gateFor(fx, { now = fx.request.receivedAt, authorities = [new URL(fx.request.target).host], directoryBody = fx.directory.body } = {}) {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return String(url) === fx.directory.url
      ? new Response(directoryBody, { status: 200, headers: { "content-type": fx.directory.contentType } })
      : new Response("not found", { status: 404 });
  };
  const siteKey = await generateSiteKey();
  const gate = await createGate({
    siteId: "gate8", siteKey: siteKey.privateJwk, now: () => now, authorities,
    routes: [{ match: new URL(fx.request.target).pathname, pressure: 2 }], resolver: { fetch },
  });
  return { gate, fetched };
}

const descriptor = (fx) => ({
  kind: "request", method: fx.request.method, targetUri: fx.request.target,
  fields: fx.request.headers.map(([name, value]) => ({ name: name.toLowerCase(), value })),
});

test("GATE-8: there is at least one real fixture, each with its provenance", () => {
  assert.ok(FIXTURES.length >= 1, "no fixture in accept/gate8/real/");
  for (const fx of FIXTURES) {
    assert.equal(fx.file, `${fx.id}.json`);
    const p = fx.provenance;
    assert.match(p?.request?.source ?? "", /^https:\/\//, `${fx.id}: where the request was captured`);
    assert.match(p.request.retrieved ?? "", /^\d{4}-\d\d-\d\dT/, `${fx.id}: when the request record was retrieved`);
    assert.match(p.request.how ?? "", /\S/, `${fx.id}: how it was captured`);
    assert.match(p?.directory?.retrieved ?? "", /^\d{4}-\d\d-\d\dT/, `${fx.id}: when the directory was retrieved`);
    assert.ok(Number.isInteger(fx.request.receivedAt), `${fx.id}: when the request arrived (ms)`);
    assert.match(fx.directory.url, /^https:\/\/[^/]+\/\.well-known\/http-message-signatures-directory$/);
    assert.match(fx.expect.identifier, /^https:\/\//);
    assert.equal(fx.expect.class, "VERIFIED");
  }
});

test("GATE-8: each directory is byte for byte the archived one", () => {
  for (const fx of FIXTURES) {
    const stored = fx.provenance.directory.archived.filter((a) => a.stored);
    assert.equal(stored.length, 1, `${fx.id}: exactly one archived directory is the stored body`);
    assert.equal(cdxDigest(fx.directory.body), stored[0].cdxDigest, `${fx.id}: the body is not what ${stored[0].url} holds`);
    assert.equal(JSON.parse(fx.directory.body).signature_agent ?? fx.agent.signatureAgent, fx.agent.signatureAgent);
  }
});

test("GATE-8: each request is really signed by a key its agent's directory published then", async () => {
  for (const fx of FIXTURES) {
    const s = signatureBase(fx);
    const keys = JSON.parse(fx.directory.body).keys;
    const jwk = keys.find((k) => thumbprint({ kty: k.kty, crv: k.crv, x: k.x }) === s.keyid);
    assert.ok(jwk, `${fx.id}: keyid ${s.keyid} is no key's RFC 7638 thumbprint in the directory`);
    if (jwk.kid) assert.equal(jwk.kid, s.keyid);
    if (jwk.nbf) assert.ok(jwk.nbf <= s.created, `${fx.id}: signed before the key's nbf`);
    if (jwk.exp) assert.ok(s.created <= jwk.exp, `${fx.id}: signed after the key's exp`);
    assert.ok(s.created * 1000 <= fx.request.receivedAt + 30_000 && fx.request.receivedAt <= s.expires * 1000, `${fx.id}: arrived inside its own validity`);
    assert.equal(await signedByDirectoryKey(fx), true, `${fx.id}: the signature does not verify on the base built from the capture`);
  }
});

test("GATE-8: the signature check bites (one change anywhere and it fails)", async () => {
  for (const fx of FIXTURES) {
    const url = new URL(fx.request.target);
    const sig = header(fx, "signature");
    const flipped = sig.replace(/:(.)/, (_, c) => `:${c === "A" ? "B" : "A"}`);
    const twins = {
      "path": withTarget(fx, `${url.origin}${url.pathname}x`),
      "authority": withTarget(fx, `${url.protocol}//www.${url.host}${url.pathname}`),
      "method": withMethod(fx, fx.request.method === "GET" ? "POST" : "GET"),
      "signature-agent": withHeader(fx, "signature-agent", header(fx, "signature-agent").replace(/"$/, "/\"")),
      "signature": withHeader(fx, "signature", flipped),
      "created": withHeader(fx, "signature-input", header(fx, "signature-input").replace(/created=(\d+)/, (_, t) => `created=${Number(t) + 1}`)),
    };
    for (const [what, twin] of Object.entries(twins)) {
      let ok; try { ok = await signedByDirectoryKey(twin); } catch { ok = false; }
      assert.equal(ok, false, `${fx.id}: still verifies with the ${what} changed`);
    }
    assert.equal(await signedByDirectoryKey(fx, fx.provenance.directory.live?.body ?? '{"keys":[]}'), false, `${fx.id}: today's directory must not hold the key (else the fixture proves nothing about "then")`);
  }
});

test("GATE-8: the Gate VERIFIES each real request as its agent", async () => {
  const seen = [];
  for (const fx of FIXTURES) {
    const { gate, fetched } = await gateFor(fx);
    const r = await gate.inspect(descriptor(fx));
    seen.push({ fx, r, fetched });
  }
  const ok = seen.filter(({ fx, r }) => r.cls.class === "VERIFIED" && r.cls.identifier === fx.expect.identifier && r.cls.keyid === fx.expect.keyid);
  console.log(`GATE-8: ${ok.length} of ${seen.length} real requests VERIFIED as their agent (${seen.map(({ fx, r }) =>
    `${fx.id}: ${r.cls.class}${r.cls.class === "VERIFIED" ? ` as ${r.cls.identifier}` : ` ${r.cls.code ?? r.cls.reason ?? ""}`}`).join("; ")})`);
  for (const { fx, r, fetched } of seen) {
    assert.deepEqual(fetched, [fx.directory.url], `${fx.id}: the Gate found the key where the agent said`);
    assert.equal(r.cls.class, "VERIFIED", `${fx.id}: ${r.cls.class} (${r.cls.reason ?? ""} ${r.cls.code ?? ""} ${r.cls.detail ?? ""})`);
    assert.equal(r.cls.identifier, fx.expect.identifier);
    assert.equal(r.cls.keyid, fx.expect.keyid);
    assert.equal(r.decision.action, "allow", `${fx.id}: a Pressure 2 route lets its agent through`);
  }
});

test("GATE-8: the real request tampered, replayed, late, elsewhere or against today's directory is never VERIFIED", async () => {
  const problems = [];
  for (const fx of FIXTURES) {
    const url = new URL(fx.request.target);
    const s = signatureBase(fx);
    const expectNot = async (what, twin, opts) => {
      const { gate } = await gateFor(twin, opts);
      const r = await gate.inspect(descriptor(twin));
      if (r.cls.class === "VERIFIED" || r.decision.action !== "deny") problems.push(`${fx.id} ${what}: ${r.cls.class}, ${r.decision.action}`);
    };
    await expectNot("path changed", withTarget(fx, `${url.origin}${url.pathname}x`));
    await expectNot("signature flipped", withHeader(fx, "signature", header(fx, "signature").replace(/:(.)/, (_, c) => `:${c === "A" ? "B" : "A"}`)));
    await expectNot("method changed", withMethod(fx, fx.request.method === "GET" ? "POST" : "GET"));
    await expectNot("another site's Host", withTarget(fx, `https://shop.example${url.pathname}`), { authorities: ["shop.example"] });
    await expectNot("replayed to another site", fx, { authorities: ["shop.example"] });
    await expectNot("after expires and the skew", fx, { now: (s.expires + 31) * 1000 });
    await expectNot("today's directory (key rotated)", fx, { directoryBody: fx.provenance.directory.live?.body ?? '{"keys":[]}' });
    // The same request twice at one Gate: the second is a replay.
    const { gate } = await gateFor(fx);
    await gate.inspect(descriptor(fx));
    const again = await gate.inspect(descriptor(fx));
    if (again.cls.class === "VERIFIED" || again.decision.action !== "deny") problems.push(`${fx.id} replayed: ${again.cls.class}, ${again.decision.action}`);
  }
  assert.deepEqual(problems, []);
});
