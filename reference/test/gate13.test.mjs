// GATE-13 (−, the pair of GATE-3, property install-effort): GATE-3's measures cannot be passed by an
// install that is bigger than it says, or a Gate that does not deliver. The same functions GATE-3
// runs on the reference apps (../gate3-measure.mjs) run here on planted installs — copies of the real
// Express install, bent one way each — and on planted first events. Each plant must be caught by its
// rule; the unbent copy and a good event are the controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REF, ROOT } from "../harness.mjs";
import { README, walk, installDiff, installProblems, eventProblems, LIMIT_S } from "../gate3-measure.mjs";

const APP = "express";
const readme = fs.readFileSync(path.join(ROOT, "packages", README[APP], "README.md"), "utf8");
const INSTALL = walk(path.join(REF, APP, "install"));
const CODE = INSTALL.find((f) => /\.m?js$/.test(f));

/** A copy of the Express site (the files the install touches) and install in a temp ref dir, bent by `bend(site, install)`. */
function plantedInstall(bend) {
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-gate13-"));
  for (const part of ["site", "install"]) {
    for (const f of walk(path.join(REF, APP, part))) {
      if (part === "site" && !INSTALL.includes(f) && f !== "package.json") continue;
      fs.mkdirSync(path.dirname(path.join(ref, APP, part, f)), { recursive: true });
      fs.copyFileSync(path.join(REF, APP, part, f), path.join(ref, APP, part, f));
    }
  }
  fs.mkdirSync(path.join(ref, APP, "install"), { recursive: true });
  bend?.(path.join(ref, APP, "site"), path.join(ref, APP, "install"));
  try { return installDiff(APP, { ref }); } finally { fs.rmSync(ref, { recursive: true, force: true }); }
}
const read = (p) => fs.readFileSync(p, "utf8");
const lines = (p) => read(p).split("\n");

test("GATE-13: GATE-3's install measure catches every planted install, and passes the real one", () => {
  const real = plantedInstall();
  assert.deepEqual(installProblems(APP, real, readme), [], "control: the real install, copied");
  assert.ok(real.codeLines >= 1 && real.codeLines <= 3, `the real install changes ${real.codeLines} lines`);
  const installed = real.files.find((f) => f.file === CODE).added.filter((l) => l.trim());
  const plants = [
    ["every installed line twice (lines the README shows, so only the count can catch it)", (s, i) => {
      const at = path.join(i, CODE), ls = lines(at);
      for (const want of installed) { const k = ls.findIndex((l) => l.trim() === want.trim()); ls.splice(k + 1, 0, ls[k]); }
      fs.writeFileSync(at, ls.join("\n"));
    }, new RegExp(`${installed.length * 2} application lines changed`)],
    ["two lines of the app changed besides the install", (s, i) => {
      const at = path.join(i, CODE), ls = lines(at);
      const picks = ls.map((l, k) => [l, k]).filter(([l]) => l.trim() && !installed.some((x) => x.trim() === l.trim())).map(([, k]) => k);
      for (const k of [picks[0], picks.at(-1)]) ls[k] += " // edited";
      fs.writeFileSync(at, ls.join("\n"));
    }, /application lines changed/],
    ["a second config file", (s, i) => fs.writeFileSync(path.join(i, "wrangler.toml"), 'name = "x"\n'), /2 config files/],
    ["a hand-edited package.json", (s, i) => {
      const pj = JSON.parse(read(path.join(s, "package.json")));
      pj.dependencies = { ...pj.dependencies, "@ludion/gate-node": "0.0.1" };
      fs.writeFileSync(path.join(i, "package.json"), JSON.stringify(pj, null, 2) + "\n");
    }, /dependencies come from npm install/],
    ["an installed line the README does not show", (s, i) => {
      const at = path.join(i, CODE);
      fs.writeFileSync(at, read(at).replace(installed[0].trim(), "app.use((req, res, next) => next()); // not the Gate"));
    }, /does not show the installed line/],
    ["an install that changes nothing", (s, i) => {
      fs.rmSync(i, { recursive: true, force: true }); fs.mkdirSync(i);
      fs.copyFileSync(path.join(s, CODE), path.join(i, CODE));
    }, /changes nothing/],
    ["an empty install", (s, i) => { fs.rmSync(i, { recursive: true, force: true }); fs.mkdirSync(i); }, /changes nothing/],
  ];
  for (const [what, bend, why] of plants) {
    const p = installProblems(APP, plantedInstall(bend), readme);
    assert.ok(p.some((x) => why.test(x)), `${what} → ${JSON.stringify(p)}`);
  }
  console.log(`GATE-13: ${plants.length} planted installs and 6 planted events caught; the real install (${real.codeLines} lines) passes`);
});

test("GATE-13: GATE-3's event check catches every planted first event, and passes a good one", () => {
  const t0 = 1000, site = "site-reference-express";
  const good = { at: t0 + 1500, event: { site, class: "SUSPECTED", route: "/products/:id" } };
  assert.deepEqual(eventProblems(APP, good, { t0, site }), [], "control");
  assert.deepEqual(eventProblems(APP, { ...good, at: t0 + LIMIT_S * 1000 }, { t0, site }), [], "exactly the limit passes");
  const plants = [
    ["no event at all", undefined, /no classified event within 60s/],
    ["a body that is not JSON", { at: t0 + 1, bad: "ok" }, /not JSON/],
    ["one millisecond late", { ...good, at: t0 + LIMIT_S * 1000 + 1 }, /after 60\.0s/],
    ["another site's event", { ...good, event: { ...good.event, site: "site-other" } }, /event for site "site-other"/],
    ["curl left unclassified", { ...good, event: { ...good.event, class: "UNKNOWN" } }, /classified UNKNOWN, not SUSPECTED/],
    ["the raw path, not the route template", { ...good, event: { ...good.event, route: "/products/2" } }, /not the template/],
  ];
  for (const [what, first, why] of plants) {
    const p = eventProblems(APP, first, { t0, site });
    assert.ok(p.some((x) => why.test(x)), `${what} → ${JSON.stringify(p)}`);
  }
});
