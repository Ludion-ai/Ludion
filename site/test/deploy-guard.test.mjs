// The preview deploy (site/deploy.mjs) only ever targets the preview Worker. This is a guard inside our
// own script, not a security boundary (docs/DEPLOY.md §5): the boundary is the credential. Pinned here
// so the guard can't quietly loosen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SITE } from "../build.mjs";
import { guard, boundary, secretKeys, PREVIEW_NAME, PREVIEW_ACCOUNT, SECRET_KEYS } from "../deploy.mjs";

test("deploy guard: the shipped site/edge/wrangler.json is the preview Worker, on workers.dev, with no route", () => {
  const config = JSON.parse(fs.readFileSync(path.join(SITE, "edge", "wrangler.json"), "utf8"));
  assert.deepEqual(guard(config), []);
  assert.equal(config.name, PREVIEW_NAME);
});

test("deploy guard: refuses production names, routes, environments and a disabled workers.dev", () => {
  const ok = { name: PREVIEW_NAME, workers_dev: true };
  for (const [bad, why] of [
    [{ ...ok, name: "ludion-site" }, "production Worker"], [{ ...ok, name: "ludion" }, "old production Worker"],
    [{ ...ok, name: "ludion-site-preview-2" }, "any other name"], [{ ...ok, route: "ludion.ai/*" }, "route"],
    [{ ...ok, routes: [{ pattern: "ludion.ai/*", custom_domain: true }] }, "custom domain"], [{ ...ok, env: { production: {} } }, "environments"],
    [{ ...ok, workers_dev: false }, "workers.dev off"], [{ name: PREVIEW_NAME }, "workers.dev unset"],
  ]) assert.ok(guard(bad).length > 0, `refuses: ${why}`);
});

// The boundary check runs against the Cloudflare API before every deploy. Here against a fake API, shaped
// like the real answers of 2026-10-01: the first "agents" token saw both accounts and read production's
// Workers (ludion-site, ludion) with 200. That token must be refused; one scoped to the agents account passes.
const AGENTS = { id: "a9", name: PREVIEW_ACCOUNT }, PROD = { id: "p1", name: "Haya0910oasis@gmail.com's Account" };
const ok = (result) => ({ status: 200, ok: true, result }), no = (status) => ({ status, ok: false });
function api(over = {}) {
  const table = {
    "/accounts?per_page=50": ok([AGENTS]), "/accounts/a9/workers/subdomain": ok({ subdomain: "ludion-agents" }),
    "/accounts/p1/workers/scripts": no(403), "/zones?per_page=50": ok([]), ...over,
  };
  const calls = [];
  return { calls, get: async (p) => { calls.push(p); return table[p] ?? no(404); } };
}

test("deploy boundary: a token scoped to the agents account, with a workers.dev subdomain, passes", async () => {
  assert.deepEqual((await boundary(api().get, "a9")).problems, []);
  assert.deepEqual((await boundary(api({ "/accounts?per_page=50": ok([AGENTS, PROD]) }).get, "a9")).problems, [], "listed but refused (403) is fine");
  assert.deepEqual((await boundary(api({ "/zones?per_page=50": no(403) }).get, "a9")).problems, []);
});

test("deploy boundary: refuses the token of 2026-10-01 (reads production's Workers) and every other reach", async () => {
  const cases = [
    [{ "/accounts?per_page=50": ok([PROD, AGENTS]), "/accounts/p1/workers/scripts": ok([{ id: "ludion-site" }, { id: "ludion" }]) }, "a9", /reads Workers in "Haya0910oasis/],
    [{ "/accounts?per_page=50": ok([PROD, AGENTS]), "/accounts/p1/workers/scripts": no(500) }, "a9", /may reach Workers/],
    [{ "/accounts?per_page=50": ok([PROD, AGENTS]), "/accounts/p1/workers/scripts": no(0) }, "a9", /may reach Workers/],
    [{ "/accounts?per_page=50": ok([PROD, AGENTS]) }, "p1", /is "Haya0910oasis.*not "Ludion Agents"/],
    [{}, "zz", /not an account this token can see/],
    [{ "/accounts?per_page=50": no(401) }, "a9", /cannot list/],
    [{ "/accounts/a9/workers/subdomain": no(404) }, "a9", /no workers\.dev subdomain/],
    [{ "/zones?per_page=50": ok([{ name: "ludion.ai" }]) }, "a9", /sees 1 zone\(s\): ludion\.ai/],
    [{ "/zones?per_page=50": no(500) }, "a9", /cannot tell which zones/],
  ];
  for (const [over, account, why] of cases) {
    const { problems } = await boundary(api(over).get, account);
    assert.ok(problems.some((p) => why.test(p)), `expected ${why}, got ${JSON.stringify(problems)}`);
  }
});

test("deploy boundary: only GETs, and only the listing, the target's subdomain, other accounts' Workers and zones", async () => {
  const a = api({ "/accounts?per_page=50": ok([PROD, AGENTS]) });
  await boundary(a.get, "a9");
  assert.deepEqual(a.calls.sort(), ["/accounts/a9/workers/subdomain", "/accounts/p1/workers/scripts", "/accounts?per_page=50", "/zones?per_page=50"]);
});

test("deploy secrets: the secrets file is uploaded whole, so only SIGNUP_WEBHOOK_URL may be in it", () => {
  assert.deepEqual(SECRET_KEYS, ["SIGNUP_WEBHOOK_URL"]);
  assert.deepEqual(secretKeys("SIGNUP_WEBHOOK_URL=https://x\n"), ["SIGNUP_WEBHOOK_URL"]);
  assert.deepEqual(secretKeys("# c\nexport SIGNUP_WEBHOOK_URL=\"u\"\r\nCLOUDFLARE_API_TOKEN=t"), ["SIGNUP_WEBHOOK_URL", "CLOUDFLARE_API_TOKEN"]);
});
