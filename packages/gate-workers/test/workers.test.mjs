// @ludion/gate-workers around a fetch handler, run on Node's Fetch API (workerd runs it for real
// in GATE-1 and GATE-3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withLudion, ludion } from "@ludion/gate-workers";

const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p), passThroughOnException() {} }; };

test("gate-workers: a human gets the app's response with only Ludion-* headers added", async () => {
  const app = { async fetch() { return new Response("hello", { status: 201, headers: { "x-app": "1" } }); }, marker: 7 };
  const w = withLudion(app);
  assert.equal(w.marker, 7, "other handler members are kept");
  const res = await w.fetch(new Request("https://shop.example/", { headers: { "user-agent": HUMAN } }), { LUDION: { site_id: "s", pressure: 3 } }, ctx());
  assert.equal(res.status, 201);
  assert.equal(await res.text(), "hello");
  assert.equal(res.headers.get("x-app"), "1");
  assert.ok([...res.headers.keys()].filter((k) => k !== "x-app" && k !== "content-type").every((k) => k.startsWith("ludion-")));
});

test("gate-workers: immutable response headers (a fetch() pass-through) are copied, the body stream kept", async () => {
  const app = { async fetch() { return Response.redirect("https://shop.example/elsewhere", 302); } };
  const res = await withLudion(app).fetch(new Request("https://shop.example/old", { headers: { "user-agent": HUMAN } }), { LUDION: '{"site_id":"s"}' }, ctx());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://shop.example/elsewhere");
  assert.ok(res.headers.get("ludion-version"));
});

test("gate-workers: an unsigned bot on a Pressure-2 route is denied and the app never runs", async () => {
  let ran = false;
  const app = { async fetch() { ran = true; return new Response("app"); } };
  const res = await withLudion(app).fetch(new Request("https://shop.example/checkout/1", { headers: { "user-agent": "python-requests/2.32.3" } }),
    { LUDION: { site_id: "s", routes: [{ match: "/checkout/**", pressure: 2 }] } }, ctx());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("ludion-error"), "signature_required");
  assert.equal(ran, false);
});

test("gate-workers: no visit is posted; an hour's counts go out when it closes, handed to ctx.waitUntil", async () => {
  const realFetch = globalThis.fetch, realNow = Date.now, posted = [];
  let t = Date.UTC(2026, 9, 3, 10, 30);
  Date.now = () => t;
  globalThis.fetch = async (url, init) => { posted.push([url, JSON.parse(init.body)]); return new Response(null, { status: 204 }); };
  try {
    const app = { async fetch() { return new Response("ok"); } };
    const w = withLudion(app), env = { LUDION: { site_id: "s", report: { endpoint: "https://collector.example/e" } } };
    const c1 = ctx();
    await w.fetch(new Request("https://shop.example/", { headers: { "user-agent": "curl/8.7.1" } }), env, c1);
    await Promise.all(c1.waits);
    assert.equal(posted.length, 0, "the visit itself is not posted (ADR-038)");
    t += 3_600_000;
    const c2 = ctx();
    await w.fetch(new Request("https://shop.example/", { headers: { "user-agent": "Mozilla/5.0" } }), env, c2);
    assert.equal(c2.waits.length, 1, "the delivery is handed to ctx.waitUntil");
    await Promise.all(c2.waits);
    assert.equal(posted.length, 1);
    assert.equal(posted[0][0], "https://collector.example/e");
    assert.equal(posted[0][1].kind, "ludion.hourly");
    assert.deepEqual(posted[0][1].rows.map((r) => [r.class, r.count]), [["SUSPECTED", 1]]);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test("gate-workers: a missing or broken config passes every request through", async () => {
  const errors = [];
  const app = { async fetch() { return new Response("app"); } };
  const w = withLudion(app, { onError: (e) => errors.push(e.message) });
  const res = await w.fetch(new Request("https://shop.example/", { headers: { "user-agent": "curl/8.7.1" } }), {}, ctx());
  assert.equal(await res.text(), "app");
  assert.equal(res.headers.get("ludion-version"), null);
  assert.match(errors[0], /must be a JSON object/);
});

test("gate-workers: ludion(request) is the Gate's result for the request the handler got; charge() never holds a human", async () => {
  let seen, other;
  const app = { async fetch(request) {
    seen = ludion(request);
    other = ludion(new Request(request.url));
    return Response.json(await seen.charge({ amount: 10 ** 9, currency: "XXX" }));
  } };
  const res = await withLudion(app).fetch(new Request("https://shop.example/checkout/1", { method: "POST", headers: { "user-agent": HUMAN } }),
    { LUDION: { site_id: "s", routes: [{ match: "/checkout/**", pressure: 2, require: { scope: "checkout" } }] } }, ctx());
  assert.equal(seen.cls.class, "UNKNOWN");
  assert.equal(other, null, "another Request object has no result");
  assert.deepEqual(await res.json(), { ok: true, enforced: false });
  assert.equal(ludion(new Request("https://shop.example/")), null, "outside the wrapper: null");
});
