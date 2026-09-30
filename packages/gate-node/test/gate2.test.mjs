// GATE-2 (docs/MISSION.md §4): pressure bites. On a Pressure-2 critical route, unverified
// automation is refused; 100% of refusals carry Ludion-Error and Link rel="help", and
// signature_required also carries Accept-Signature. Real HTTP through @ludion/gate-node,
// with requests that really are each class (no synthetic classification objects).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { parseDictionary } from "structured-headers";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey, denialHeaders, decide, ACCEPT_SIGNATURE } from "@ludion/gate-core";
import { keypair, signed, staple, withFields, fieldOf, AGENT, NOW_MS, NOW_S, REGISTRY_ISS } from "../../gate-core/test/support.mjs";

const agent = await keypair();
const stranger = await keypair();
const registry = await keypair();
const noNetwork = async () => new Response("", { status: 404 }); // an unprimed directory is simply unavailable

const ROUTES = [
  { match: "/checkout/**", pressure: 2 },
  { match: "/login", pressure: 2, require: { depth: 1 } },
  { match: "/post/**", pressure: 2, require: { ballast: "active" } },
  { match: "/pay/**", pressure: 2, require: { scope: "checkout" } },
  { match: "/api/search", pressure: 1 },
];

async function site({ pressure = 0, routes = ROUTES } = {}) {
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({
    siteId: "site-gate2", siteKey: siteKey.privateJwk, pressure, routes, now: () => NOW_MS,
    registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS, resolver: { fetch: noNetwork },
  });
  await mw.gate.resolver.prime({ type: "directory", uri: AGENT }, { keys: [{ ...agent.publicJwk, use: "sig" }] });
  const srv = http.createServer((req, res) => mw(req, res, () => { res.writeHead(200, { "content-type": "text/plain" }); res.end("app"); }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  return { origin: `http://127.0.0.1:${srv.address().port}`, gate: mw.gate };
}

const headersOf = (desc) => Object.fromEntries(desc.fields.map((f) => [f.name, f.value]));
const UA = { human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
  declared: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", suspected: "python-requests/2.32.3" };

/** One request of every class, built for real against `origin`. */
async function requestsOfEveryClass(origin, path) {
  const url = `${origin}${path}`;
  const good = await signed({ key: agent, url });
  const sig = fieldOf(good, "signature");
  const b = Buffer.from(sig.slice(sig.indexOf(":") + 1, -1), "base64"); b[0] ^= 1;
  const stp = (extra) => staple(registry, { jkt: agent.kid, ...extra });
  const withStaple = async (s) => signed({ key: agent, url, headers: { "ludion-staple": s }, extraComponents: ["ludion-staple"] });
  return {
    UNKNOWN: { headers: { "user-agent": UA.human } },
    DECLARED: { headers: { "user-agent": UA.declared } },
    SUSPECTED: { headers: { "user-agent": UA.suspected } },
    UNVERIFIED: { headers: headersOf(await signed({ key: stranger, url })) },
    UNVERIFIED_UNAVAILABLE: { headers: headersOf(await signed({ key: agent, url, agent: "https://unavailable.example" })) },
    SPOOFED: { headers: headersOf(withFields(good, { signature: `sig1=:${b.toString("base64")}:` })) },
    REVOKED: { headers: headersOf(await withStaple(await stp({ revoked: true }))) },
    VERIFIED: { headers: headersOf(await signed({ key: agent, url })) },
    VERIFIED_STAPLE_EXPIRED: { headers: headersOf(await withStaple(await stp({ iat: NOW_S - 3600, exp: NOW_S - 60 }))) },
    VERIFIED_D2_NO_BALLAST: { headers: headersOf(await withStaple(await stp({ depth: 2, ballast: { status: "none" } }))) },
    VERIFIED_D2: { headers: headersOf(await withStaple(await stp({ depth: 2 }))) },
  };
}

function assertDenialShape(res, expectCode, why) {
  const code = res.headers.get("ludion-error");
  assert.ok(code, `${why}: denial without Ludion-Error (status ${res.status})`);
  if (expectCode) assert.equal(code, expectCode, why);
  const link = res.headers.get("link") ?? "";
  assert.ok(new RegExp(`^<https://ludion\\.ai/e/${code}>;\\s*rel="help"$`).test(link), `${why}: Link rel="help" for ${code}, got ${link}`);
  const acc = res.headers.get("accept-signature");
  if (code === "signature_required") {
    assert.ok(acc, `${why}: signature_required without Accept-Signature`);
    const dict = parseDictionary(acc);
    const [[, [items, params]]] = [...dict];
    assert.equal(params.get("tag"), "web-bot-auth", why);
    const names = items.map(([n]) => n);
    assert.ok(names.includes("@authority") && names.includes("signature-agent"), `${why}: Accept-Signature asks for @authority and signature-agent`);
  } else assert.equal(acc, null, `${why}: Accept-Signature only with signature_required`);
  assert.ok([401, 403, 429].includes(res.status), `${why}: status ${res.status}`);
}

test("GATE-2: every non-VERIFIED automation class is refused on the Pressure-2 route, with the full denial shape", async () => {
  const { origin } = await site();
  const reqs = await requestsOfEveryClass(origin, "/checkout/1");
  const expect = { DECLARED: "signature_required", SUSPECTED: "signature_required", UNVERIFIED: "signature_required",
    UNVERIFIED_UNAVAILABLE: "signature_required", SPOOFED: "invalid_signature", REVOKED: "revoked", VERIFIED_STAPLE_EXPIRED: "staple_expired" };
  for (const [name, code] of Object.entries(expect)) {
    const res = await fetch(`${origin}/checkout/1`, reqs[name]);
    assert.notEqual(res.status, 200, `${name} must be refused`);
    assertDenialShape(res, code, name);
    const body = await res.json();
    assert.equal(body.error, code, `${name}: body names the same error`);
    assert.equal(body.help, `https://ludion.ai/e/${code}`, `${name}: body links the same help page`);
  }
  for (const name of ["UNKNOWN", "VERIFIED", "VERIFIED_D2"]) {
    const res = await fetch(`${origin}/checkout/1`, reqs[name]);
    assert.equal(res.status, 200, `${name} passes`);
    assert.equal(await res.text(), "app");
    assert.equal(res.headers.get("ludion-error"), null, `${name}: no error header on a pass`);
  }
});

test("GATE-2: route requirements refuse with their own codes and the full denial shape", async () => {
  const { origin } = await site();
  const cases = [
    ["/login", "VERIFIED", "depth_insufficient"], ["/post/1", "VERIFIED_D2_NO_BALLAST", "ballast_required"],
    ["/pay/1", "VERIFIED_D2", "mandate_required"], ["/login", "SUSPECTED", "signature_required"],
  ];
  for (const [path, name, code] of cases) {
    const reqs = await requestsOfEveryClass(origin, path);
    const res = await fetch(`${origin}${path}`, reqs[name]);
    assertDenialShape(res, code, `${name} on ${path}`);
  }
  const reqs = await requestsOfEveryClass(origin, "/login");
  assert.equal((await fetch(`${origin}/login`, reqs.VERIFIED_D2)).status, 200, "depth 2 meets depth 1");
});

test("GATE-2: Pressure 3 applies to every route; humans still pass", async () => {
  const { origin } = await site({ pressure: 3, routes: [] });
  const reqs = await requestsOfEveryClass(origin, "/anything");
  for (const name of ["DECLARED", "SUSPECTED", "UNVERIFIED", "SPOOFED", "REVOKED"]) {
    const res = await fetch(`${origin}/anything`, reqs[name]);
    assert.notEqual(res.status, 200, `${name} refused at P3`);
    assertDenialShape(res, null, `${name} at P3`);
  }
  assert.equal((await fetch(`${origin}/anything`, reqs.UNKNOWN)).status, 200);
  assert.equal((await fetch(`${origin}/anything`, reqs.VERIFIED)).status, 200);
});

test("GATE-2: every error code decide() can emit gets the full denial shape (incl. codes not yet reachable by requests)", () => {
  const src = fs.readFileSync(new URL("../../gate-core/src/classify.mjs", import.meta.url), "utf8");
  const decideSrc = src.slice(src.indexOf("export function decide"));
  const codes = new Set(decideSrc.split("\n").filter((l) => l.includes("error:"))
    .flatMap((l) => [...l.slice(l.indexOf("error:")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1])));
  for (const c of ["signature_required", "invalid_signature", "staple_expired", "revoked", "depth_insufficient", "mandate_required", "mandate_scope", "ballast_required"]) {
    assert.ok(codes.has(c), `decide() vocabulary includes ${c} (found ${[...codes]})`);
  }
  for (const code of codes) {
    const h = denialHeaders({ action: "deny", status: 401, error: code });
    assert.equal(h["Ludion-Error"], code);
    assert.equal(h.Link, `<https://ludion.ai/e/${code}>; rel="help"`);
    assert.equal(h["Accept-Signature"], code === "signature_required" ? ACCEPT_SIGNATURE : undefined, code);
  }
  assert.deepEqual(denialHeaders({ action: "allow" }), {});
  assert.deepEqual(denialHeaders({ action: "friction" }), {});
});

test("GATE-2: randomized sweep — any deny from the Gate carries the shape; non-VERIFIED automation never passes a P≥2 route", async () => {
  const { origin, gate } = await site();
  const paths = ["/checkout/1", "/login", "/post/1", "/pay/1", "/api/search", "/"];
  let seed = 7; const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const pools = {}; for (const p of paths) pools[p] = await requestsOfEveryClass(origin, p);
  let denials = 0;
  for (let i = 0; i < 400; i++) {
    const path = paths[rnd(paths.length)];
    const names = Object.keys(pools[path]);
    const name = names[rnd(names.length)];
    const fresh = name.startsWith("VERIFIED") || name === "REVOKED" ? (await requestsOfEveryClass(origin, path))[name] : pools[path][name]; // nonces are single-use
    const res = await fetch(`${origin}${path}`, fresh);
    const route = gate.policy.forPath(path);
    const automation = name !== "UNKNOWN", verified = name.startsWith("VERIFIED");
    if (res.status !== 200) { denials++; assertDenialShape(res, null, `${name} on ${path}`); }
    else assert.equal(res.headers.get("ludion-error"), null, `${name} on ${path}: pass without error header`);
    if (automation && !verified && route.pressure >= 2) assert.notEqual(res.status, 200, `${name} passed ${path} at P${route.pressure}`);
    if (!automation || route.pressure < 2) assert.equal(res.status, 200, `${name} on ${path} at P${route.pressure} must pass`);
  }
  assert.ok(denials > 50, `sweep exercised denials (${denials})`);
  assert.equal(decide({ class: "UNKNOWN" }, { pressure: 3, require: { depth: 4 } }).action, "allow");
});
