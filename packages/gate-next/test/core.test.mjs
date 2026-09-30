// @ludion/gate-next core, without Next.js: `next` is NextResponse.next's stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNextGate, describe } from "../core.mjs";

const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const next = () => new Response(null, { headers: { "x-middleware-next": "1" } });
const gateWith = (spec, extra = {}) => createNextGate({ next, loadConfig: async () => spec, env: {}, ...extra });

test("gate-next: a human continues to the app, carrying only Ludion-* headers", async () => {
  const { proxy } = gateWith({ site_id: "s", pressure: 3 });
  const res = await proxy(new Request("https://shop.example/checkout/1", { headers: { "user-agent": HUMAN } }));
  assert.equal(res.headers.get("x-middleware-next"), "1");
  assert.equal(res.status, 200);
  const added = [...res.headers.keys()].filter((k) => k !== "x-middleware-next");
  assert.ok(added.length > 0 && added.every((k) => k.startsWith("ludion-")), added.join(","));
});

test("gate-next: an unsigned bot on a Pressure-2 route is denied with the help link", async () => {
  const { proxy } = gateWith({ site_id: "s", routes: [{ match: "/checkout/**", pressure: 2 }] });
  const res = await proxy(new Request("https://shop.example/checkout/1", { headers: { "user-agent": "curl/8.7.1" } }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("ludion-error"), "signature_required");
  assert.match(res.headers.get("link"), /rel="help"/);
  assert.ok(res.headers.get("accept-signature"));
  assert.equal((await res.json()).error, "signature_required");
});

test("gate-next: a broken config never takes the site down, and is reported once", async () => {
  const errors = [];
  const { proxy } = createNextGate({ next, loadConfig: async () => ({ site_id: "s", presure: 2 }), env: {}, onError: (e) => errors.push(e.message) });
  for (let i = 0; i < 3; i++) {
    const res = await proxy(new Request("https://shop.example/", { headers: { "user-agent": "curl/8.7.1" } }));
    assert.equal(res.headers.get("x-middleware-next"), "1");
  }
  assert.equal(errors.length, 3, "each pass-through is reported to onError (the default logs once)");
  assert.match(errors[0], /unknown key "presure"/);
});

test("gate-next: the request descriptor keeps method, URL and every header", () => {
  const d = describe(new Request("https://shop.example/a?b=c", { method: "POST", headers: { "signature-input": "x", "user-agent": "u" }, body: "" }));
  assert.equal(d.method, "POST");
  assert.equal(d.targetUri, "https://shop.example/a?b=c");
  assert.deepEqual(d.fields.find((f) => f.name === "signature-input"), { name: "signature-input", value: "x" });
});
