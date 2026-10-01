// GATE-7 route evasion, pinned from both sides. A real Express 5 app (the most common Node
// router) decides which raw request-targets reach its critical handlers; for every one that does,
// unverified automation must be denied by the Gate, and a browser must get exactly what the app
// without a Gate gives. Then the matcher itself: it errs toward protection, but explicit
// carve-outs, neighbouring paths and the site's base pressure stay as configured.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import express from "express";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey, createPolicy, compileRoute, originForm, routeCandidates } from "@ludion/gate-core";

const UA = { human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
  bot: "python-requests/2.32.3", crawler: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" };

function shop(gate) {
  const app = express();
  if (gate) app.use(gate);
  app.get("/checkout/:id", (req, res) => res.send(`CRITICAL checkout ${req.params.id}`));
  app.post("/checkout", (req, res) => res.send("CRITICAL checkout-post"));
  app.get("/login", (req, res) => res.send("CRITICAL login"));
  app.get("/about", (req, res) => res.send("about"));
  app.use((req, res) => res.status(404).send("not found"));
  return app;
}
const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
async function listen(app) {
  const srv = app.listen(0, "127.0.0.1");
  servers.push(srv);
  await new Promise((r) => srv.on("listening", r));
  return srv.address().port;
}
const siteKey = await generateSiteKey();
const gated = await listen(shop(await ludionGate({ siteId: "site-evasion", siteKey: siteKey.privateJwk,
  routes: [{ match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2 }], resolver: { fetch: async () => new Response("", { status: 404 }) } })));
const bare = await listen(shop(null));

/** Raw bytes on a socket, so the request-target reaches the server exactly as written. */
function send(port, method, target, ua) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1"), chunks = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("error", () => {});
    sock.on("close", () => {
      const s = Buffer.concat(chunks).toString("latin1"), i = s.indexOf("\r\n\r\n");
      resolve({ status: Number(s.split(" ")[1]), ludionError: /\r\nludion-error: *([^\r]+)/i.exec(s.slice(0, i))?.[1], body: s.slice(i + 4) });
    });
    sock.write(`${method} ${target} HTTP/1.1\r\nHost: shop.example\r\nUser-Agent: ${ua}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
}

const TARGETS = [
  "/checkout/1", "/CHECKOUT/1", "/Checkout/1", "/checkout/1/", "/checkout/1;x=1", "/checkout/%31", "/checkout/1.", "/checkout/1%20",
  "/checkout/1?x=1", "/checkout/1#x", "//checkout/1", "/./checkout/1", "/a/../checkout/1", "/a/%2e%2e/checkout/1", "/%63heckout/1",
  "/checkout%2F1", "/checkout;x=1/1", "/checkout\\1", "https://shop.example/checkout/1", "http://other.example/checkout/1",
  "/login", "/LOGIN", "/login/", "/Login/", "//login", "/%6Cogin", "/login;jsessionid=1", "/login.json", "/login.", "/login%2F",
].map((t) => ["GET", t]).concat([["POST", "/checkout"], ["POST", "/CHECKOUT"], ["POST", "/checkout/"], ["POST", "https://shop.example/checkout"]]);

test("GATE-7: every spelling a real Express app routes to a critical handler is denied to unverified automation; browsers get the app's own answer", async () => {
  const critical = [];
  for (const [method, target] of TARGETS) {
    const app = await send(bare, method, target, UA.human);
    const human = await send(gated, method, target, UA.human);
    assert.equal(human.status, app.status, `${method} ${target}: a browser sees the app's status`);
    assert.equal(human.body, app.body, `${method} ${target}: a browser sees the app's body`);
    assert.equal(human.ludionError, undefined, `${method} ${target}: a browser is never refused`);
    if (!app.body.startsWith("CRITICAL")) continue;
    critical.push(`${method} ${target}`);
    for (const ua of [UA.bot, UA.crawler]) {
      const bot = await send(gated, method, target, ua);
      assert.equal(bot.status, 401, `${method} ${target} (${ua.slice(0, 16)}) reached the critical handler: ${bot.body}`);
      assert.equal(bot.ludionError, "signature_required");
    }
  }
  // Express's own routing rules, so the test cannot pass by testing nothing.
  for (const must of ["GET /CHECKOUT/1", "GET /login/", "GET /LOGIN", "POST /checkout", "GET https://shop.example/checkout/1", "GET http://other.example/checkout/1"]) {
    assert.ok(critical.includes(must), `Express routes ${must} to a critical handler (it did: ${critical.join(", ")})`);
  }
});

test("GATE-7: unverified automation on neighbouring and ordinary paths is not pulled onto a critical route", async () => {
  for (const target of ["/about", "/checkoutx/1", "/logins", "/log/in", "/api/login-status", "/checkout-help"]) {
    const bot = await send(gated, "GET", target, UA.bot);
    assert.equal(bot.ludionError, undefined, `${target} is not a protected route`);
  }
});

// Until 2026-10-01 a narrower lower-Pressure route listed first ("/checkout/help" at P0 before
// "/checkout/**" at P2) carved a hole in the broader one. The human's rule for overlapping routes
// (Codex audit #8, PRS-4) is that the strictest wins, so that path is now protected like its route.
test("GATE-7: the matcher errs toward protection, keeps neighbours and the base pressure; an overlapping lower route is no carve-out", () => {
  const p = createPolicy({ pressure: 0, routes: [{ match: "/checkout/help", pressure: 0 }, { match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2, require: { depth: 1 } }] });
  const at = (path) => p.forPath(path).pressure;
  for (const path of ["/checkout", "/checkout/", "/CHECKOUT/9", "/login", "/login/", "/LOGIN", "/%6Cogin", "/x/../login", "/login;a=b", "/login.json", "/login.", "//login", "/checkout%2F9", "/checkout/help.json",
    "/checkout/help", "/CHECKOUT/HELP", "/checkout/help/"]) {
    assert.equal(at(path), 2, `${path} is protected`);
  }
  assert.deepEqual(p.forPath("/Login/").require, { depth: 1 }, "the protecting route's requirements come with it");
  for (const path of ["/checkoutx", "/logins", "/log/in", "/about", "/"]) {
    assert.equal(at(path), 0, `${path} keeps its configured pressure`);
  }
  // A lower-pressure route can never be reached by spelling a path oddly: the higher pressure wins.
  const strict = createPolicy({ pressure: 3, routes: [{ match: "/public/**", pressure: 0 }] });
  assert.equal(strict.forPath("/public/x").pressure, 0);
  assert.equal(strict.forPath("/PUBLIC/x").pressure, 0);
  assert.equal(strict.forPath("/%70ublic/x").pressure, 3, "a spelling the literal path does not match keeps the site's pressure");
  assert.equal(strict.forPath("/public/../admin").pressure, 3);
});

test("GATE-7: compileRoute and originForm", () => {
  assert.ok(compileRoute("/checkout/**").test("/checkout"));
  assert.ok(compileRoute("/checkout/**").test("/Checkout/a/b"));
  assert.ok(!compileRoute("/checkout/**").test("/checkoutx"));
  assert.ok(compileRoute("/login").test("/login/"));
  assert.ok(!compileRoute("/login").test("/login/x"));
  assert.ok(compileRoute("/api/*/pay").test("/API/v1/pay"));
  assert.ok(!compileRoute("/api/*/pay").test("/api/v1/x/pay"));
  assert.equal(originForm("https://shop.example/checkout/1?x=1#f"), "/checkout/1?x=1");
  assert.equal(originForm("http://other.example"), "/");
  assert.equal(originForm("/checkout/1"), "/checkout/1");
  assert.equal(originForm("*"), "*");
  assert.deepEqual(routeCandidates("/login"), ["/login"]);
  assert.deepEqual(routeCandidates("/a/%2E%2E//login;x=1/"), ["/a/%2E%2E//login;x=1/", "/login"]);
  assert.ok(routeCandidates("/%E0%A4%A/%6Cogin").includes("/%E0%A4%A/login"), "malformed UTF-8 still decodes the ASCII escapes");
});
