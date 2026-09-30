#!/usr/bin/env node
// GATE-4 (docs/MISSION.md §4, spec §11.6): with key sets and Registry keys cached, the Gate adds
// ≤ 2 ms at p99 over 10,000 requests of mixed classification.
//
// What is timed: the real @ludion/gate-node middleware, from the call until it hands the request
// to the app (next) or answers it (a denial): describing the request, classifying it (RFC 9421
// verification, Staple verification, replay check), deciding, signing the Glass receipt, setting
// the headers and handing the metadata event to the sink. The network and HTTP parsing are the
// same with or without the Gate and are not part of what it adds. Requests are built and signed
// before timing (the agent's cost, not the site's). Warm-up requests are excluded. The class mix
// is checked afterwards, so a Gate that skipped work would fail on the counts, not pass on speed.
// Last line of output: JSON { pass, p50, p99, max, n, classes }.
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey } from "@ludion/gate-core";
import { keypair, signed, staple, withFields, fieldOf, AGENT, NOW_MS, REGISTRY_ISS } from "../../gate-core/test/support.mjs";

const N = 10_000, WARMUP = 1_000, LIMIT_MS = 2;
const UAS = {
  UNKNOWN: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  DECLARED: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  SUSPECTED: "python-requests/2.32.3",
};
const PATHS = ["/", "/products/42", "/search?q=shoes", "/checkout/7", "/login", "/account/orders", "/blog/post-1"];

const [agent, stranger, registry] = await Promise.all([keypair(), keypair(), keypair()]);
const siteKey = await generateSiteKey();
const events = [];
const mw = await ludionGate({
  siteId: "site-gate4", siteKey: siteKey.privateJwk, pressure: 0, now: () => NOW_MS, authorities: ["shop.example"],
  routes: [{ match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2, require: { depth: 1 } }, { match: "/search", pressure: 1 }],
  registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS,
  resolver: { fetch: async () => new Response("", { status: 404 }) },   // never used warm: everything below is cached
  sink: (e) => { events.push(e.cls ?? e.class); },
});
await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
const goodStaple = await staple(registry, { sub: "dvr-benchbenchbench2", jkt: agent.kid, depth: 2 });

/** An IncomingMessage as Node hands it to the middleware. */
function incoming(desc) {
  const url = new URL(desc.targetUri);
  const fields = [{ name: "host", value: url.host }, ...desc.fields];
  const headers = {};
  for (const f of fields) headers[f.name.toLowerCase()] = f.value;
  return { method: desc.method, url: `${url.pathname}${url.search}`, rawHeaders: fields.flatMap((f) => [f.name, f.value]), headers,
    socket: { encrypted: true, remoteAddress: "203.0.113.7" } };
}
const plain = (ua, path) => ({ kind: "request", method: "GET", targetUri: `https://shop.example${path}`, fields: [{ name: "user-agent", value: ua }] });

// The mix: what a Pressure-0 site with a few Pressure-2 routes sees, every class represented.
const KINDS = ["UNKNOWN", "UNKNOWN", "UNKNOWN", "DECLARED", "SUSPECTED", "VERIFIED", "VERIFIED_STAPLED", "UNVERIFIED", "SPOOFED", "SPOOFED_UNSIGNED"];
const EXPECT = { UNKNOWN: "UNKNOWN", DECLARED: "DECLARED", SUSPECTED: "SUSPECTED", VERIFIED: "VERIFIED", VERIFIED_STAPLED: "VERIFIED",
  UNVERIFIED: "UNVERIFIED", SPOOFED: "SPOOFED", SPOOFED_UNSIGNED: "SPOOFED" };
async function build(i) {
  const kind = KINDS[i % KINDS.length], path = PATHS[i % PATHS.length], url = `https://shop.example${path}`;
  switch (kind) {
    case "UNKNOWN": case "DECLARED": case "SUSPECTED": return { kind, req: incoming(plain(UAS[kind], path)) };
    case "VERIFIED": return { kind, req: incoming(await signed({ key: agent, url })) };
    case "VERIFIED_STAPLED": return { kind, req: incoming(await signed({ key: agent, url, extraComponents: ["ludion-staple"], headers: { "ludion-staple": goodStaple } })) };
    case "UNVERIFIED": return { kind, req: incoming(await signed({ key: stranger, url })) }; // a key the agent's directory does not publish
    case "SPOOFED": { const r = await signed({ key: agent, url }); return { kind, req: incoming(withFields(r, { signature: fieldOf(r, "signature").replace(/.{4}:$/, "AAA=:") })) }; }
    case "SPOOFED_UNSIGNED": return { kind, req: incoming({ ...plain(UAS.UNKNOWN, path), fields: [{ name: "user-agent", value: UAS.UNKNOWN }, { name: "signature-agent", value: `sig1="${AGENT}"` }] }) };
  }
}

function run(req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, setHeader() {}, end() { resolve(); } };
    Promise.resolve(mw(req, res, resolve)).catch(reject);
  });
}

const total = WARMUP + N;
const work = [];
for (let i = 0; i < total; i++) work.push(await build(i));

const samples = [];
const seen = {};
const wrong = [];
for (let i = 0; i < total; i++) {
  const { kind, req } = work[i];
  const t0 = performance.now();
  await run(req);
  const ms = performance.now() - t0;
  if (i < WARMUP) continue;
  samples.push(ms);
  if (process.env.GATE4_BY_KIND) ((globalThis.byKind ??= {})[kind] ??= []).push(ms);
  const got = req.ludion?.cls?.class;
  seen[got] = (seen[got] ?? 0) + 1;
  if (got !== EXPECT[kind]) wrong.push(`${kind}→${got}`);
  else if (kind === "VERIFIED_STAPLED" && req.ludion.cls.depth !== 2) wrong.push(`${kind}→depth ${req.ludion.cls.depth}`);
  else if (!req.ludion.receipt) wrong.push(`${kind}→no receipt`);
}
samples.sort((a, b) => a - b);
const q = (p) => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)];
const p50 = q(0.5), p99 = q(0.99), max = samples[samples.length - 1];
const problems = [];
if (wrong.length) problems.push(`${wrong.length} requests classified unexpectedly, e.g. ${[...new Set(wrong)].slice(0, 5).join(", ")}`);
for (const k of Object.values(EXPECT)) if (!seen[k]) problems.push(`class ${k} never exercised`);
if (p99 > LIMIT_MS) problems.push(`p99 ${p99.toFixed(3)}ms > ${LIMIT_MS}ms`);
const round = (x) => Math.round(x * 1000) / 1000;
if (process.env.GATE4_BY_KIND) for (const [k, v] of Object.entries(globalThis.byKind)) {
  v.sort((a, b) => a - b);
  console.log(`  ${k.padEnd(18)} p50=${round(v[Math.floor(v.length / 2)])} p99=${round(v[Math.ceil(v.length * 0.99) - 1])}`);
}
console.log(`GATE-4: n=${N} p50=${round(p50)}ms p99=${round(p99)}ms max=${round(max)}ms classes=${JSON.stringify(seen)}`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(JSON.stringify({ pass: problems.length === 0, p50: round(p50), p99: round(p99), max: round(max), n: N, classes: seen, problems }));
process.exit(problems.length ? 1 : 0);
