// PRS-1 (±): 100,000 random cases over classification × Pressure × route requirements, through
// the real policy (createPolicy / forPath, incl. the ADR-021 path spellings) and decide().
//   + UNKNOWN always passes; a VERIFIED request meeting its route's requirements always passes.
//   − a denial only ever happens where the effective Pressure is ≥ 2, and there every automation
//     class that does not qualify is denied, with a spec §10.11 shape.
// Seeded PRNG: PRS_SEED=<n> reproduces a run; the seed and the first failing case are printed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicy, compileRoute, decide, CLASSES, AUTOMATION } from "../src/index.mjs";

const CASES = Number(process.env.PRS_CASES ?? 100_000);
const SEED = Number(process.env.PRS_SEED ?? (Date.now() % 2 ** 31));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATTERNS = ["/checkout/**", "/login", "/account/*", "/api/:id/pay", "/post/**", "/search", "/cart", "/admin/**", "/signup", "/api/**"];
const PATHS = ["/checkout", "/checkout/1", "/checkout/1/confirm", "/login", "/account/orders", "/api/7/pay", "/api/v1/items", "/post/new",
  "/search", "/cart", "/admin/users", "/signup", "/about", "/", "/products/42", "/blog/post-1"];
const SCOPES = ["checkout", "account", "post"];
const DENY_SHAPES = { signature_required: 401, invalid_signature: 401, staple_expired: 401, revoked: 403, depth_insufficient: 403,
  mandate_required: 403, mandate_scope: 403, ballast_required: 403, rate_limited: 429 };

function world(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (n) => Math.floor(rnd() * n);
  const require = () => {
    const r = {};
    if (rnd() < 0.4) r.depth = int(5);
    if (rnd() < 0.3) r.ballast = "active";
    if (rnd() < 0.25) r.scope = pick(SCOPES);
    return rnd() < 0.2 ? undefined : r;
  };
  const routes = Array.from({ length: int(6) }, () => ({ match: pick(PATTERNS), pressure: int(4), ...(rnd() < 0.7 ? { require: require() } : {}) }));
  const base = int(4);
  // A spelling an app may route like the plain path (ADR-021), or the plain path itself.
  const spell = (p) => {
    const muts = [
      (s) => s.toUpperCase(), (s) => s.replace(/^\/(\w)/, (m, c) => `/${c.toUpperCase()}`), (s) => `${s}/`, (s) => `/${s}`,
      (s) => `/./${s.slice(1)}`, (s) => `/x/..${s}`, (s) => s.replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`),
      (s) => `${s};jsessionid=1`, (s) => `${s}.json`, (s) => `${s}.`, (s) => s.replace(/\//g, "\\"), (s) => `${s}%3F`,
    ]; // forPath() is handed a pathname (routePath), which never carries a raw query
    let s = p;
    for (let i = int(3); i > 0; i--) s = pick(muts)(s);
    return s;
  };
  const cls = () => {
    const c = { class: pick(CLASSES) };
    if (c.class === "VERIFIED" || c.class === "REVOKED") {
      c.depth = int(5);
      c.ballast = { status: pick(["none", "active", "suspended"]) };
      if (rnd() < 0.5) c.mandate = { scope: SCOPES.filter(() => rnd() < 0.5) };
      if (rnd() < 0.1) c.stapleError = pick(["staple_expired", "no_registry_keys"]);
    }
    if (c.class === "UNVERIFIED" && rnd() < 0.2) c.stapleError = "staple_expired";
    return c;
  };
  return { routes, base, path: spell(pick(PATHS)), cls: cls() };
}

/** Does `c` meet the route's requirements (the part of decide() a qualified agent must satisfy)? */
function qualifies(c, req) {
  if (c.class !== "VERIFIED" || c.stapleError === "staple_expired") return false;
  if (!req) return true;
  if (req.depth !== undefined && (c.depth ?? 0) < req.depth) return false;
  if (req.ballast === "active" && c.ballast?.status !== "active") return false;
  if (req.scope && ![].concat(req.scope).every((s) => c.mandate?.scope?.includes(s))) return false; // overlapping routes: every scope (PRS-4)
  return true;
}

function check(w) {
  const policy = createPolicy({ pressure: w.base, routes: w.routes });
  const route = policy.forPath(w.path);
  const d = decide(w.cls, route);
  const configured = new Set([w.base, ...w.routes.map((r) => r.pressure ?? w.base)]);
  // The floor, computed here: the strictest of every route the literal path matches (PRS-4), never forPath's choice.
  const literal = w.routes.filter((r) => compileRoute(r.match).test(w.path));
  const floor = literal.length ? Math.max(...literal.map((r) => r.pressure ?? w.base)) : null;
  const problems = [];
  if (!configured.has(route.pressure)) problems.push(`pressure ${route.pressure} is not one the site configured`);
  if (floor != null && route.pressure < floor) problems.push(`protection below the strictest route the literal path matches (P${floor}: ${literal.map((r) => r.match).join(", ")})`);
  if (w.cls.class === "UNKNOWN" && d.action !== "allow") problems.push(`UNKNOWN got ${d.action}`);
  if (qualifies(w.cls, route.require) && d.action !== "allow") problems.push(`qualifying VERIFIED got ${d.action} (${d.error})`);
  if (d.action === "deny") {
    if (route.pressure < 2) problems.push(`denied at Pressure ${route.pressure}`);
    if (!AUTOMATION.has(w.cls.class)) problems.push(`denied a non-automation class ${w.cls.class}`);
    if (DENY_SHAPES[d.error] === undefined || DENY_SHAPES[d.error] !== d.status) problems.push(`denial shape ${d.status} ${d.error} is not in spec §10.11`);
  }
  if (route.pressure >= 2 && AUTOMATION.has(w.cls.class) && !qualifies(w.cls, route.require) && d.action !== "deny") {
    problems.push(`Pressure ${route.pressure}: non-qualifying ${w.cls.class} got ${d.action}`);
  }
  if (route.pressure === 1 && d.action === "deny") problems.push("Pressure 1 is friction, never a block");
  return { problems, route, d };
}

test(`PRS-1: ${CASES.toLocaleString("en")} random decisions keep humans and qualified agents through; denials only at Pressure ≥ 2, and there they bite (seed ${SEED})`, () => {
  const rnd = mulberry32(SEED);
  const tally = { allow: 0, friction: 0, deny: 0 };
  for (let i = 0; i < CASES; i++) {
    const w = world(rnd);
    const { problems, route, d } = check(w);
    tally[d.action]++;
    if (problems.length) {
      assert.fail(`seed ${SEED}, case ${i}: ${problems.join("; ")}\n  ${JSON.stringify({ base: w.base, routes: w.routes, path: w.path, cls: w.cls, route, decision: d })}`);
    }
  }
  // The generator must actually reach every outcome, or the properties prove little.
  for (const k of ["allow", "friction", "deny"]) assert.ok(tally[k] > CASES / 50, `too few ${k} outcomes (${tally[k]}) — the generator is not exercising the space`);
});

test("PRS-1: the checker itself bites — a decide() that denies humans, or waves through an unqualified agent, is caught", () => {
  const route = { pressure: 2, require: { depth: 2 }, template: "/checkout/**" };
  const base = { base: 0, routes: [{ match: "/checkout/**", pressure: 2, require: { depth: 2 } }], path: "/checkout/1" };
  assert.deepEqual(check({ ...base, cls: { class: "UNKNOWN" } }).problems, []);
  assert.deepEqual(check({ ...base, cls: { class: "VERIFIED", depth: 1, ballast: { status: "none" } } }).problems, []);
  assert.equal(decide({ class: "VERIFIED", depth: 1 }, route).action, "deny");
  assert.equal(qualifies({ class: "VERIFIED", depth: 3 }, route.require), true);
  assert.equal(qualifies({ class: "VERIFIED", depth: 3, stapleError: "staple_expired" }, route.require), false);
});
