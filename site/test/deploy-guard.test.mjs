// The preview deploy (site/deploy.mjs) only ever targets the preview Worker. This is a guard inside our
// own script, not a security boundary (docs/DEPLOY.md §5): the boundary is the credential. Pinned here
// so the guard can't quietly loosen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SITE } from "../build.mjs";
import { guard, PREVIEW_NAME } from "../deploy.mjs";

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
