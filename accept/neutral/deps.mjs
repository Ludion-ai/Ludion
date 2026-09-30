#!/usr/bin/env node
// NEUT-2 (docs/MISSION.md §4): gate-core's dependency tree holds no CDN or cloud vendor SDK.
// Spec §8.3: Ludion depends on no particular CDN, lab, cloud or payment network.
//
// The tree is resolved from package-lock.json with Node's lookup rules (nearest node_modules
// first), for dependencies, optionalDependencies and non-optional peerDependencies, transitively.
// Every package in it is checked three ways:
//   1. its name or scope is not a vendor SDK (VENDOR_NAMES),
//   2. its repository / homepage / bugs URL is not a vendor organisation (VENDOR_ORGS),
//   3. its code names no vendor API endpoint (VENDOR_ENDPOINTS).
// A package that fails 2 is allowed ONLY if it is listed in STANDARD_REFERENCE by exact name and
// version and still passes 1 and 3 (ADR-027). Any other version, or any other package from those
// organisations, fails. Card Host is held to the same rule.
//
// Before looking at the repo it tests itself: planted vendor SDKs (by name, transitively, by
// repository, by endpoint, as a peer, as an allowed name at another version, and injected into a
// copy of the real lockfile) must all be caught. Output: `ok …` lines; exit 1 on any finding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED = ["packages/gate-core", "packages/card-host"];

/** Vendor SDKs, runtimes and CLIs, by exact name or scope. Generous on purpose. */
const VENDOR_NAMES = [
  // Cloudflare
  /^@cloudflare\//, /^cloudflare$/, /^wrangler$/, /^miniflare$/, /^workerd$/, /^@miniflare\//, /^cf-/,
  // Vercel
  /^@vercel\//, /^vercel$/, /^@edge-runtime\//, /^edge-runtime$/, /^@next\/(env|swc)/,
  // AWS
  /^@aws-sdk\//, /^aws-sdk$/, /^@aws-crypto\//, /^@aws-amplify\//, /^aws-amplify$/, /^@smithy\//, /^aws4$/, /^aws-cdk/, /^@aws-cdk\//, /^aws-lambda$/, /^@aws-lambda-powertools\//,
  // Google
  /^@google-cloud\//, /^googleapis$/, /^@googleapis\//, /^google-auth-library$/, /^firebase/, /^@firebase\//, /^@google\/(genai|maps)/,
  // Microsoft
  /^@azure\//, /^@azure-rest\//, /^azure-/, /^@microsoft\/(azure|applicationinsights)/, /^applicationinsights$/,
  // Other CDNs, edges and clouds
  /^@fastly\//, /^fastly$/, /^@netlify\//, /^netlify/, /^@akamai\//, /^akamai/, /^@supabase\//, /^supabase$/, /^@deno\/deploy/, /^deployctl$/,
  /^@edgio\//, /^@layer0\//, /^@bunny\.net\//, /^bunnycdn/, /^@upstash\//, /^@neondatabase\//, /^@planetscale\//, /^@fly\//, /^@alicloud\//, /^@tencentcloud\//,
  /^tencentcloud-sdk/, /^@ibm-cloud\//, /^ibm-cloud-sdk/, /^oci-/, /^@oracle\/oci/, /^@digitalocean\//, /^@heroku\//, /^heroku/, /^@railway\//, /^@render\//,
  /^@stackpath\//, /^@imperva\//, /^@gcore\//, /^@sentry\//, /^@datadog\//, /^dd-trace$/, /^newrelic$/,
];

/** Vendor organisations (repository, homepage, bugs). */
const VENDOR_ORGS = /(github\.com|gitlab\.com|bitbucket\.org)[/:](cloudflare|cloudflareresearch|vercel|vercel-labs|aws|awslabs|aws-amplify|aws-samples|aws-powertools|smithy-lang|googleapis|googlecloudplatform|google-cloud|firebase|azure|azure-samples|microsoft\/azure|fastly|netlify|akamai|supabase|denoland\/deploy|superfly|upstash|neondatabase|planetscale|edgio|getsentry|datadog)\b/i;

/** Vendor API endpoints a library would call (not header names, not prose). */
const VENDOR_ENDPOINTS = /\b(api\.cloudflare\.com|[a-z0-9-]+\.workers\.dev|cloudflareaccess\.com|[a-z0-9.-]*\.amazonaws\.com|[a-z0-9.-]*\.googleapis\.com|firebaseio\.com|api\.vercel\.com|vercel\.com\/api|[a-z0-9.-]*\.vercel-storage\.com|api\.fastly\.com|api\.netlify\.com|[a-z0-9.-]*\.azure\.com|[a-z0-9.-]*\.windows\.net|[a-z0-9.-]*\.akamaiapis\.net|[a-z0-9.-]*\.supabase\.co)\b/i;

/**
 * Published by a vendor organisation, allowed because it is the IETF standard's reference
 * implementation, not a vendor SDK (ADR-027): protocol code only, Apache-2.0, no vendor account,
 * service or endpoint. Exact name@version: an upgrade fails until a human re-reviews it here.
 */
const STANDARD_REFERENCE = new Map([
  // draft-meunier-web-bot-auth-architecture / draft-ietf-webbotauth-httpsig-protocol reference implementation.
  ["web-bot-auth@0.2.0", "Web Bot Auth reference implementation (cloudflare/web-bot-auth, packages/web-bot-auth)"],
  // RFC 9421 HTTP Message Signatures, from the same reference repository.
  ["http-message-sig@0.3.0", "RFC 9421 implementation (cloudflare/web-bot-auth, packages/http-message-sig)"],
  // RFC 7638 JWK thumbprint, from the same reference repository.
  ["jsonwebkey-thumbprint@0.1.0", "RFC 7638 implementation (cloudflareresearch/web-bot-auth, packages/jwt-thumbprint)"],
]);

const urlsOf = (meta) => [meta?.repository?.url ?? meta?.repository, meta?.homepage, meta?.bugs?.url ?? meta?.bugs]
  .filter((u) => typeof u === "string");

/** Where `name` resolves from the package installed at lock path `from` (Node's lookup). */
function resolvePath(lock, from, name) {
  let p = from;
  for (;;) {
    const cand = p ? `${p}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[cand]) return cand;
    if (!p) return undefined;
    const i = p.lastIndexOf("/node_modules/");
    p = i >= 0 ? p.slice(0, i) : p.startsWith("node_modules/") ? "" : "";
  }
}

/**
 * The transitive tree of `start` (a lock path), with how each package was reached.
 * @returns {{ nodes: Map<string, { name: string, version?: string, path?: string, via: string[] }> }}
 */
export function tree(lock, start) {
  const nodes = new Map();
  const queue = [{ path: start, via: [] }];
  const seen = new Set();
  while (queue.length) {
    const { path: p0, via } = queue.shift();
    let p = p0, entry = lock.packages[p];
    if (entry?.link && entry.resolved) { p = entry.resolved; entry = lock.packages[p]; }
    if (!entry || seen.has(p)) continue;
    seen.add(p);
    const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([n]) => n));
    const deps = { ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies };
    for (const name of Object.keys(deps)) {
      if (optionalPeers.has(name) && !(entry.dependencies?.[name] || entry.optionalDependencies?.[name])) continue;
      const where = resolvePath(lock, p, name);
      const target = where ? lock.packages[where] : undefined;
      const real = target?.link && target.resolved ? target.resolved : where;
      const key = real ?? `unresolved:${name}`;
      const chain = [...via, name];
      if (!nodes.has(key)) nodes.set(key, { name, version: real ? lock.packages[real]?.version : undefined, path: real, via: chain });
      if (real) queue.push({ path: real, via: chain });
    }
  }
  return { nodes };
}

/**
 * Findings for one checked package.
 * @param {object} lock parsed package-lock.json (v2/v3 "packages")
 * @param {string} start lock path of the checked package
 * @param {{ meta: (p: string) => object|undefined, code: (p: string) => string[] }} read
 */
export function check(lock, start, read) {
  const findings = [], allowed = [];
  const { nodes } = tree(lock, start);
  for (const n of nodes.values()) {
    const id = `${n.name}@${n.version ?? "?"}`, how = n.via.join(" > ");
    if (VENDOR_NAMES.some((re) => re.test(n.name))) { findings.push(`${id} is a vendor SDK by name (${how})`); continue; }
    const meta = n.path ? read.meta(n.path) : undefined;
    const vendorUrl = urlsOf(meta).find((u) => VENDOR_ORGS.test(u));
    const endpoint = n.path ? read.code(n.path).map((s) => s.match(VENDOR_ENDPOINTS)?.[0]).find(Boolean) : undefined;
    if (endpoint) { findings.push(`${id} calls a vendor endpoint ${endpoint} (${how})`); continue; }
    if (vendorUrl) {
      if (STANDARD_REFERENCE.has(id)) allowed.push(id);
      else findings.push(`${id} is published by a vendor organisation (${vendorUrl}) and is not an allowed standard reference implementation at this exact version (${how})`);
    }
  }
  return { findings, allowed, size: nodes.size };
}

function diskReader(root) {
  const walk = (d, out = []) => {
    if (!fs.existsSync(d)) return out;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, out); else if (/\.(c|m)?js$/.test(e.name)) out.push(f);
    }
    return out;
  };
  return {
    meta: (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p, "package.json"), "utf8")); } catch { return undefined; } },
    code: (p) => walk(path.join(root, p)).map((f) => fs.readFileSync(f, "utf8")),
  };
}

// ── self-test: the checker must catch what it claims to catch ─────────────────────────────────
function selfTest(realLock, realReader) {
  const problems = [];
  const lockOf = (packages) => ({ lockfileVersion: 3, packages: { "": {}, ...packages } });
  const reader = (meta = {}, code = {}) => ({ meta: (p) => meta[p], code: (p) => code[p] ?? [] });
  const expectCaught = (label, lock, rd, re) => {
    const r = check(lock, "packages/gate-core", rd);
    if (!r.findings.some((f) => re.test(f))) problems.push(`self-test "${label}" not caught (findings: ${r.findings.join("; ") || "none"})`);
  };
  const clean = lockOf({ "packages/gate-core": { dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0" } });
  if (check(clean, "packages/gate-core", reader()).findings.length) problems.push("self-test: a clean tree was flagged");
  expectCaught("vendor SDK by name", lockOf({ "packages/gate-core": { dependencies: { "@aws-sdk/client-s3": "3.0.0" } }, "node_modules/@aws-sdk/client-s3": { version: "3.0.0" } }), reader(), /@aws-sdk\/client-s3@3\.0\.0 is a vendor SDK/);
  expectCaught("transitive vendor SDK", lockOf({ "packages/gate-core": { dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0", dependencies: { b: "1" } }, "node_modules/a/node_modules/b": { version: "1.0.0", dependencies: { wrangler: "4" } }, "node_modules/wrangler": { version: "4.0.0" } }), reader(), /wrangler@4\.0\.0 is a vendor SDK by name \(a > b > wrangler\)/);
  expectCaught("vendor by repository", lockOf({ "packages/gate-core": { dependencies: { harmless: "1.0.0" } }, "node_modules/harmless": { version: "1.0.0" } }), reader({ "node_modules/harmless": { repository: { url: "git+https://github.com/vercel/harmless.git" } } }), /harmless@1\.0\.0 is published by a vendor organisation/);
  expectCaught("vendor endpoint in code", lockOf({ "packages/gate-core": { dependencies: { quiet: "1.0.0" } }, "node_modules/quiet": { version: "1.0.0" } }), reader({}, { "node_modules/quiet": ['fetch("https://api.cloudflare.com/client/v4/zones")'] }), /quiet@1\.0\.0 calls a vendor endpoint api\.cloudflare\.com/);
  expectCaught("non-optional peer", lockOf({ "packages/gate-core": { peerDependencies: { "@vercel/edge": "*" } } }), reader(), /@vercel\/edge@\? is a vendor SDK/);
  expectCaught("allowed name at another version", lockOf({ "packages/gate-core": { dependencies: { "web-bot-auth": "0.2.1" } }, "node_modules/web-bot-auth": { version: "0.2.1" } }), reader({ "node_modules/web-bot-auth": { repository: { url: "git+https://github.com/cloudflare/web-bot-auth.git" } } }), /web-bot-auth@0\.2\.1 is published by a vendor organisation/);
  expectCaught("allowed name@version that calls a vendor endpoint", lockOf({ "packages/gate-core": { dependencies: { "web-bot-auth": "0.2.0" } }, "node_modules/web-bot-auth": { version: "0.2.0" } }), reader({ "node_modules/web-bot-auth": { repository: { url: "git+https://github.com/cloudflare/web-bot-auth.git" } } }, { "node_modules/web-bot-auth": ["const u = 'https://x.workers.dev/k'"] }), /web-bot-auth@0\.2\.0 calls a vendor endpoint/);
  // A copy of the real lockfile with a vendor SDK added to gate-core's dependencies.
  const copy = structuredClone(realLock);
  copy.packages["packages/gate-core"].dependencies = { ...copy.packages["packages/gate-core"].dependencies, "@cloudflare/workers-types": "4.0.0" };
  copy.packages["node_modules/@cloudflare/workers-types"] = { version: "4.0.0" };
  const r = check(copy, "packages/gate-core", realReader);
  if (!r.findings.some((f) => /@cloudflare\/workers-types@4\.0\.0 is a vendor SDK/.test(f))) problems.push("self-test: a vendor SDK injected into a copy of the real lockfile was not caught");
  return problems;
}

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const read = diskReader(ROOT);
const problems = selfTest(lock, read);
if (!problems.length) console.log("ok self-test: vendor SDKs by name, transitively, by repository, by endpoint, as a peer, at another version, injected into the real lockfile");
for (const start of CHECKED) {
  if (!lock.packages[start]) { problems.push(`${start} missing from package-lock.json`); continue; }
  const r = check(lock, start, read);
  for (const f of r.findings) problems.push(`${start}: ${f}`);
  if (!r.findings.length) console.log(`ok ${start}: ${r.size} packages in the tree, 0 vendor SDKs${r.allowed.length ? `; standard reference implementations allowed by exact version: ${r.allowed.join(", ")}` : ""}`);
}
for (const p of problems) console.log(`FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
