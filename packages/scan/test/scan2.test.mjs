// SCAN-2 (+, pair SCAN-3): on labelled fixtures, the counts per class, per route kind, and the
// number of unverified automation requests that touched critical routes equal the ground truth
// exactly. The truth is labelled by hand in the generator's tables, not computed by the scan.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { scan } from "@ludion/scan";
import { routeKind, isCritical } from "@ludion/gate-core/route";
import { truths, runScan, sumExpect, CORPUS } from "./support.mjs";

const TS = truths();
const pickCounts = (r) => ({ classes: r.classes, operators: r.operators, signals: r.signals, kinds: r.kinds,
  critical: { unverified_automation: r.critical.unverified_automation, served: r.critical.served, by_kind: r.critical.by_kind },
  no_user_agent_field: r.no_user_agent_field });
const sorted = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v)));

test("SCAN-2: every file's counts equal its ground truth exactly", async () => {
  for (const t of TS) {
    const r = await scan([path.join(CORPUS, t.file)]);
    assert.deepEqual(sorted(pickCounts(r)), sorted(t.expect), t.file);
  }
});

test("SCAN-2: the whole corpus through the CLI equals the summed ground truth", () => {
  const want = sumExpect(TS);
  const r = runScan([CORPUS, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sorted(pickCounts(JSON.parse(r.stdout))), sorted(want));
  const text = runScan([CORPUS]).stdout;
  assert.match(text, new RegExp(`UNVERIFIED AUTOMATION ON CRITICAL ROUTES: ${want.critical.unverified_automation.toLocaleString("en-US")}\\b`));
  assert.match(text, new RegExp(`served: ${want.critical.served.toLocaleString("en-US")}\\b`));
});

test("SCAN-2: the labelled corpus exercises every class the scan can produce, every kind, and the critical number", () => {
  const w = sumExpect(TS);
  for (const c of ["DECLARED", "SUSPECTED", "UNVERIFIED", "UNKNOWN"]) assert.ok(w.classes[c] > 20, `${c}: ${w.classes[c]}`);
  for (const c of ["VERIFIED", "SPOOFED", "REVOKED"]) assert.equal(w.classes[c], 0, `a log cannot yield ${c}`);
  for (const [k, v] of Object.entries(w.kinds)) assert.ok(Object.values(v).reduce((a, b) => a + b, 0) > 0, `kind ${k} never occurs`);
  assert.ok(w.critical.unverified_automation > 100 && w.critical.served > 0 && w.critical.served < w.critical.unverified_automation);
  assert.ok(Object.keys(w.operators).length >= 8 && Object.keys(w.signals).length >= 10);
  assert.ok(w.no_user_agent_field > 0);
});

test("SCAN-2: route kinds and critical routes follow the documented rule", () => {
  const cases = [
    ["GET", "/", "browse", false], ["GET", "/blog/checkout-tips", "browse", false], ["GET", "/checkout", "checkout", true],
    ["GET", "/account/login", "login", true], ["GET", "/my-account/orders", "checkout", true], ["POST", "/api/cart/add", "checkout", true],
    ["GET", "/customer/account/login/", "login", true], ["POST", "/wp-login.php", "login", true], ["POST", "/xmlrpc.php", "login", true],
    ["GET", "/Account/Login.aspx", "login", true], ["GET", "/signup", "signup", true], ["GET", "/wp-admin/", "account", true],
    ["GET", "/products?q=shoes", "search", false], ["GET", "/search", "search", false], ["GET", "/api/v1/products", "api", false],
    ["POST", "/graphql", "api", true], ["DELETE", "/v2/items/9", "api", true], ["POST", "/contact", "form", true], ["GET", "/contact", "form", false],
    ["GET", "/images/login.png", "asset", false], ["GET", "/static/cart.js", "asset", false], ["GET", "/favicon.ico", "asset", false],
    ["GET", "http://example.com/cart", "checkout", true], ["GET", "*", "malformed", false], ["CONNECT", "example.com:443", "malformed", false],
    ["GET", "/%E3%82%AB%E3%83%BC%E3%83%88", "browse", false], ["HEAD", "/login", "login", true], ["PATCH", "/about", "browse", true],
  ];
  for (const [m, target, kind, critical] of cases) {
    const k = routeKind(m, target);
    assert.equal(k, kind, `${m} ${target}`);
    assert.equal(k !== "malformed" && isCritical(m, k), critical, `${m} ${target} critical`);
  }
});
