// WEB-1 (+, pair WEB-5): the site is deployed to the Cloudflare preview (site/preview.json, written by
// `npm run deploy:preview`), and what the preview serves is THIS checkout's build: its _build.json is
// this checkout's siteHash(), and every page's bytes equal the local build's. Every page exists in
// English and Japanese, and every page ON THE PREVIEW scores Lighthouse mobile ≥95 in Performance,
// Accessibility, Best Practices and SEO.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SITE, buildSite, siteHash } from "../build.mjs";
import { lighthouseRunner, MIN_SCORE } from "./lighthouse.mjs";
import { pairing, htmlFiles, urlOf } from "./pages.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
let preview, dist, lh;
before(async () => {
  const file = path.join(SITE, "preview.json");
  assert.ok(fs.existsSync(file), "site/preview.json is missing: run `npm run deploy:preview`");
  preview = JSON.parse(fs.readFileSync(file, "utf8"));
  dist = buildSite();
});
after(async () => { await lh?.close(); });

test("WEB-1: the preview is a workers.dev URL and serves this checkout's build", async () => {
  assert.match(preview.url, /^https:\/\/ludion-site-preview\.[a-z0-9-]+\.workers\.dev$/);
  const r = await fetch(`${preview.url}/_build.json`, { cache: "no-store" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).site, siteHash(), "the preview is stale: run `npm run deploy:preview`");
});

test("WEB-1: every page on the preview is byte-identical to the local build, in English and Japanese", async () => {
  const p = pairing(dist);
  assert.deepEqual(p.problems, []);
  const diffs = [];
  for (const f of htmlFiles(dist)) {
    const r = await fetch(preview.url + urlOf(f), { cache: "no-store" });
    const body = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) diffs.push(`${urlOf(f)} → ${r.status}`);
    else if (sha(body) !== sha(fs.readFileSync(path.join(dist, f)))) diffs.push(`${urlOf(f)} differs from the build`);
  }
  assert.deepEqual(diffs, []);
});

test("WEB-1: Lighthouse mobile ≥95 in all four categories on every page of the preview", async () => {
  lh = await lighthouseRunner();
  const failing = [], low = [];
  for (const f of htmlFiles(dist)) {
    const r = await lh.audit(preview.url + urlOf(f));
    low.push(Math.min(...Object.values(r.scores)));
    for (const x of r.failing) failing.push(`${urlOf(f)}: ${x}`);
  }
  assert.deepEqual(failing, [], `below ${MIN_SCORE}`);
  console.log(`# WEB-1: ${preview.url}; ${low.length} pages (en + ja), lowest score ${Math.min(...low)}`);
});
