#!/usr/bin/env node
// Build (or reuse) the cached installs of every reference app, without running any check.
// The scoreboard runs this in its parallel phase so the exclusive GATE-1 measures only responses.
//   node reference/prepare.mjs [app…]
import { APPS, prepare } from "./harness.mjs";

const apps = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(APPS);
for (const app of apps) {
  const t = Date.now();
  const { key } = prepare(app);
  console.log(`ok ${app} ${key} ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
