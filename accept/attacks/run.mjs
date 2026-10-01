#!/usr/bin/env node
// GATE-7 runner. The corpus is every accept/attacks/*.json: data naming an attack `family`
// and its `params`. Each attack runs in a fresh world (victim agent with a sibling key and a
// Staple, an attacker with their own directory and Staple, a pinned Registry, a Gate at P0 with
// Pressure-2 routes). A family yields steps: `verified` steps are controls proving the setup is
// honest; `rejected` steps are the attack and must be refused (not VERIFIED, no Staple standing,
// denied on the P2 route). Families that attack how a raw request reaches the app (route-evasion)
// run their steps through the real @ludion/gate-node adapter, where `rejected` also means the
// request never reached the app; `human` steps must reach it untouched, and `denied` controls
// prove the route is protected when spelled plainly. Exit 1 if any attack gets through, the
// corpus is empty, a required family is missing, or an attack that exists on the base branch was
// deleted (the corpus only grows).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rejected, AGENT, NOW_MS } from "../../packages/gate-core/test/support.mjs";
import { CLASSES } from "@ludion/gate-core";
import { FAMILIES, REQUIRED, world, throughNode } from "./families.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../..");

function baseCorpus() {
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let ref = "HEAD";
  try { ref = git("merge-base", "HEAD", "origin/main"); } catch { /* no remote: compare with the last commit */ }
  try { return git("ls-tree", "--name-only", `${ref}:accept/attacks/`).split("\n").filter((f) => f.endsWith(".json")); } catch { return []; }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const problems = [];
if (!files.length) problems.push("corpus is empty");
const deleted = baseCorpus().filter((f) => !files.includes(f));
if (deleted.length) problems.push(`corpus shrank; deleted: ${deleted.join(", ")}`);
const families = new Set();

for (const f of files) {
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { problems.push(`${f}: not JSON`); continue; }
  const id = f.replace(/\.json$/, "");
  if (spec.id !== id) { problems.push(`${f}: id ${spec.id} must equal the file name`); continue; }
  if (!FAMILIES[spec.family]) { problems.push(`${id}: unknown family ${spec.family}`); continue; }
  if (!spec.title) { problems.push(`${id}: needs a title`); continue; }
  // The class each attack must get (spec §10.8), declared in the corpus and reviewed, never taken
  // from what the Gate answers: a regeneration cannot quietly move an attack to another class.
  if (!Array.isArray(spec.classes) || !spec.classes.length || !spec.classes.every((c) => CLASSES.includes(c))) { problems.push(`${id}: needs "classes", the spec §10.8 classes its attack steps must get`); continue; }
  families.add(spec.family);
  try {
    const w = await world();
    const steps = await FAMILIES[spec.family](spec.params ?? {}, w);
    if (!steps.some((s) => s.expect === "rejected")) throw new Error("family produced no attack step");
    const seen = [];
    for (const [i, s] of steps.entries()) {
      w.t = NOW_MS + s.atS * 1000;
      const out = s.node ? await throughNode(s.node, s.req) : null;
      const r = out ? out.result : await (s.gate ?? w.gate).inspect(s.req);
      seen.push(r.cls.class);
      if (s.expect === "verified" && r.cls.class !== "VERIFIED") throw new Error(`control step ${i} not VERIFIED (${r.cls.class} ${r.cls.reason ?? ""} ${r.cls.detail ?? ""}) — the attack proves nothing`);
      if (s.expect === "human" && (!out?.reachedApp || out.headers["ludion-error"])) throw new Error(`human step ${i} was touched (${out?.status} ${out?.headers["ludion-error"] ?? ""})`);
      if (s.expect === "denied" && (!out || out.reachedApp || ![401, 403].includes(out.status))) throw new Error(`control step ${i}: the plainly spelled route is not protected — the attack proves nothing`);
      if (!["verified", "human", "denied", "rejected", "flood"].includes(s.expect)) throw new Error(`step ${i}: unknown expectation ${s.expect}`);
      if (s.expect === "rejected") {
        const p = rejected(r, { victim: AGENT });
        if (!spec.classes.includes(r.cls.class)) p.push(`class ${r.cls.class}, but the corpus declares ${spec.classes.join(" or ")}`);
        if (out && (out.reachedApp || !out.headers["ludion-error"])) p.push(`reached the app (route ${r.route?.template ?? "none"}, Pressure ${r.route?.pressure})`);
        if (p.length) throw new Error(`GOT THROUGH at step ${i}: ${p.join("; ")}`);
      }
    }
    console.log(`ok   ${id}  ${seen.join(" → ")}`);
  } catch (e) { problems.push(`${id}: ${e.message}`); }
}
for (const fam of REQUIRED) if (!families.has(fam)) problems.push(`required attack family missing from the corpus: ${fam}`);

for (const p of problems) console.log(`FAIL ${p}`);
console.log(`\n${files.length} attacks, ${families.size} families, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
