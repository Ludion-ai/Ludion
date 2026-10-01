// PRS-4 (±): overlapping routes. The rule (decided by the human, 2026-10-01, Codex audit #8): where
// routes overlap, the strictest wins — the highest Pressure among every route the path matches, and
// every requirement any of them names (the highest depth, ballast if any asks for it, every scope).
// A broad route never lowers a narrower one, a narrower one never carves a hole in a broader one,
// and the order the site lists them in never matters.
//   + a request that meets every matching route's requirements passes; paths no route matches
//     keep the site's Pressure;
//   − a leading `/**` at P0 does not drop /checkout to P0; an agent meeting one route's
//     requirements but not another's is refused. Expectations are computed here from the rule,
//     route by route with compileRoute, never from forPath().
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPolicy, compileRoute, decide } from "../src/index.mjs";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey } from "../src/index.mjs";

const SUSPECTED = { class: "SUSPECTED", signal: "python-requests" };

test("PRS-4: a broad Pressure 0 route listed first does not drop /checkout to Pressure 0, in either order", () => {
  const broadFirst = [{ match: "/**", pressure: 0 }, { match: "/checkout", pressure: 2 }];
  for (const routes of [broadFirst, [...broadFirst].reverse()]) {
    const p = createPolicy({ pressure: 0, routes });
    const at = p.forPath("/checkout");
    assert.equal(at.pressure, 2, JSON.stringify(routes));
    assert.equal(decide(SUSPECTED, at).action, "deny", "unverified automation is refused there");
    assert.equal(decide({ class: "UNKNOWN" }, at).action, "allow", "humans never are");
    assert.equal(p.forPath("/about").pressure, 0, "a path only the broad route matches keeps its Pressure");
  }
});

test("PRS-4: a narrower, lower-Pressure route does not carve a hole in a broader protected one", () => {
  const routes = [{ match: "/checkout/help", pressure: 0 }, { match: "/checkout/**", pressure: 2, require: { depth: 1 } }];
  for (const order of [routes, [...routes].reverse()]) {
    const at = createPolicy({ pressure: 0, routes: order }).forPath("/checkout/help");
    assert.equal(at.pressure, 2);
    assert.deepEqual(at.require, { depth: 1 });
  }
});

test("PRS-4: every matching route's requirements apply together; meeting one route's is not enough", () => {
  const routes = [
    { match: "/**", pressure: 1, require: { ballast: "active" } },
    { match: "/checkout/**", pressure: 2, require: { depth: 1 } },
    { match: "/checkout/pay", pressure: 2, require: { depth: 2, scope: "checkout" } },
    { match: "/checkout/pay", pressure: 2, require: { scope: "account" } },
  ];
  const at = createPolicy({ pressure: 0, routes }).forPath("/checkout/pay");
  assert.equal(at.pressure, 2);
  assert.equal(at.require.depth, 2, "the highest depth");
  assert.equal(at.require.ballast, "active", "ballast, because one route asks for it");
  assert.deepEqual([].concat(at.require.scope).sort(), ["account", "checkout"], "every scope");
  const agent = (o) => ({ class: "VERIFIED", depth: 2, ballast: { status: "active" }, mandate: { scope: ["checkout", "account"] }, ...o });
  assert.equal(decide(agent(), at).action, "allow", "meets them all");
  assert.equal(decide(agent({ depth: 1 }), at).error, "depth_insufficient");
  assert.equal(decide(agent({ ballast: { status: "none" } }), at).error, "ballast_required");
  assert.equal(decide(agent({ mandate: { scope: ["checkout"] } }), at).error, "mandate_scope", "one scope of two");
  assert.equal(decide(agent({ mandate: undefined }), at).error, "mandate_required");
});

// ── the rule, computed here, against forPath on random overlapping route sets ─────────────────
const PATTERNS = ["/**", "/*", "/checkout", "/checkout/**", "/checkout/pay", "/checkout/:id", "/login", "/account/**", "/account/*/orders", "/api/**", "/api/:v/pay"];
const PATHS = ["/", "/checkout", "/checkout/pay", "/checkout/7", "/login", "/account", "/account/me/orders", "/api/v1/pay", "/api/v1/items", "/about"];
const SCOPES = ["checkout", "account", "post"];
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SEED = Number(process.env.PRS_SEED ?? (Date.now() % 2 ** 31));

/** The rule, from scratch: every route whose pattern matches the path, strictest of each. */
function expected(base, routes, path) {
  const hits = routes.filter((r) => compileRoute(r.match).test(path));
  if (!hits.length) return { pressure: base, depth: undefined, ballast: false, scopes: [] };
  return {
    pressure: Math.max(...hits.map((r) => r.pressure ?? base)),
    depth: hits.some((r) => r.require?.depth !== undefined) ? Math.max(...hits.filter((r) => r.require?.depth !== undefined).map((r) => r.require.depth)) : undefined,
    ballast: hits.some((r) => r.require?.ballast === "active"),
    scopes: [...new Set(hits.flatMap((r) => (r.require?.scope ? [r.require.scope] : [])))].sort(),
  };
}

test(`PRS-4: 20,000 random overlapping route sets — forPath gives the strictest of the matching routes, in every order (seed ${SEED})`, () => {
  const rnd = mulberry32(SEED);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let overlaps = 0;
  for (let i = 0; i < 20_000; i++) {
    const routes = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const r = { match: pick(PATTERNS) };
      if (rnd() < 0.85) r.pressure = Math.floor(rnd() * 4);
      if (rnd() < 0.6) {
        const q = {};
        if (rnd() < 0.5) q.depth = Math.floor(rnd() * 4);
        if (rnd() < 0.3) q.ballast = "active";
        if (rnd() < 0.4) q.scope = pick(SCOPES);
        r.require = q;
      }
      return r;
    });
    const base = Math.floor(rnd() * 4), path = pick(PATHS);
    const want = expected(base, routes, path);
    if (routes.filter((r) => compileRoute(r.match).test(path)).length > 1) overlaps++;
    for (const order of [routes, [...routes].reverse(), [...routes].sort(() => rnd() - 0.5)]) {
      const got = createPolicy({ pressure: base, routes: order }).forPath(path);
      const req = got.require ?? {};
      const at = `seed ${SEED} case ${i}: ${JSON.stringify({ base, routes: order, path })} → ${JSON.stringify(got)}`;
      assert.equal(got.pressure, want.pressure, `pressure: ${at}`);
      assert.equal(req.depth, want.depth, `depth: ${at}`);
      assert.equal(req.ballast === "active", want.ballast, `ballast: ${at}`);
      assert.deepEqual([].concat(req.scope ?? []).sort(), want.scopes, `scopes: ${at}`);
    }
  }
  assert.ok(overlaps > 2_000, `the generator must overlap routes often (${overlaps} of 20,000)`);
});

test("PRS-4: through the real Node adapter, an unsigned bot on /checkout under a leading `/**` at Pressure 0 is refused; a browser is not", async () => {
  const mw = await ludionGate({ siteId: "site-prs4", siteKey: (await generateSiteKey()).privateJwk, authorities: ["127.0.0.1"],
    routes: [{ match: "/**", pressure: 0 }, { match: "/checkout/**", pressure: 2 }], resolver: { fetch: async () => new Response("", { status: 404 }) } });
  const srv = http.createServer((req, res) => mw(req, res, () => res.end("app")));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  const get = (path, ua) => new Promise((ok, fail) => http.get(`http://127.0.0.1:${srv.address().port}${path}`, { headers: { "user-agent": ua }, agent: false },
    (res) => { res.resume(); res.on("end", () => ok({ status: res.statusCode, error: res.headers["ludion-error"] })); }).on("error", fail));
  assert.deepEqual(await get("/checkout/1", "python-requests/2.32.3"), { status: 401, error: "signature_required" });
  assert.deepEqual(await get("/checkout/1", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"), { status: 200, error: undefined });
  assert.deepEqual(await get("/about", "python-requests/2.32.3"), { status: 200, error: undefined });
});
