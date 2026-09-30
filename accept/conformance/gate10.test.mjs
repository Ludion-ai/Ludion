// GATE-10 (+): the conformance suite is data. accept/conformance/vectors.json holds the WG test
// vectors and every GATE-7 attack as concrete requests; it matches the corpus one for one, is
// exactly what a fresh export writes, carries no private key, and the TypeScript Gate passes every
// case reading nothing but the file (here on Node; NEUT-1 runs the same file on Deno and workerd).
// A Gate in another language (GATE-9) reads the same file. The runner must also refuse vectors
// that are wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, registerConformance } from "../../packages/gate-core/test/portable/conformance.mjs";
import { exportText } from "./export.mjs";
import { std2Titles } from "./std2.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ATTACKS = path.resolve(DIR, "../attacks");
const text = fs.readFileSync(path.join(DIR, "vectors.json"), "utf8");
const V = JSON.parse(text);
const byId = new Map(V.cases.map((c) => [c.id, c]));
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

test("GATE-10: the vectors are the corpus, one for one, and the WG vectors", () => {
  assert.equal(V.version, 1);
  assert.equal(byId.size, V.cases.length, "case ids are unique");
  const corpus = fs.readdirSync(ATTACKS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(ATTACKS, f), "utf8")));
  const problems = [];
  for (const a of corpus) {
    const c = byId.get(a.id);
    if (!c) { problems.push(`${a.id}: in the corpus, not in the vectors (re-run node accept/conformance/export.mjs)`); continue; }
    if (c.family !== a.family || c.title !== a.title || canon(c.params) !== canon(a.params ?? {})) problems.push(`${a.id}: the corpus entry changed since the export`);
    if (!c.steps.some((s) => s.expect === "rejected")) problems.push(`${a.id}: no attack step`);
  }
  for (const c of V.cases.filter((x) => x.source === "GATE-7")) if (!corpus.some((a) => a.id === c.id)) problems.push(`${c.id}: in the vectors, not in the corpus`);
  assert.deepEqual(problems, []);
  assert.ok(["wg-e2-1--signature-verifies", "wg-e2-1--one-flipped-byte", "wg-e2-1--gate-holds-to-60s"].every((id) => byId.get(id)?.source === "STD-1"),
    "the WG App. E.2.1 vector: verifies, its tampered twin does not, and a Gate holds it to 60 s");
  assert.equal(V.cases.filter((c) => c.source === "GATE-7").length, corpus.length);
});

test("GATE-10: every STD-2 test has its case, with the classes spec §10.8 prescribes", () => {
  const titles = std2Titles(fs.readFileSync(path.resolve(DIR, "../../packages/gate-core/test/std2.test.mjs"), "utf8"));
  assert.ok(titles.length >= 12, `STD-2 tests found: ${titles.length}`);
  const std2 = V.cases.filter((c) => c.source === "STD-2");
  assert.deepEqual(std2.map((c) => c.group), titles, "one case per STD-2 test, in order (re-run node accept/conformance/export.mjs)");
  for (const c of std2) for (const s of c.steps) {
    if (s.expect === "rejected") assert.ok(Array.isArray(s.classes) && s.classes.length, `${c.id}: a refusal names its class`);
    if (s.expect === "verified") assert.match(s.identifier ?? "", /^https:\/\//, `${c.id}: a control names whom it verifies as`);
  }
});

test("GATE-10: the file is exactly what the families and the WG vectors produce (a fresh export, byte for byte)", async () => {
  const fresh = await exportText();
  if (fresh !== text) {
    const a = text.split("\n"), b = fresh.split("\n");
    const i = a.findIndex((l, n) => l !== b[n]);
    assert.fail(`accept/conformance/vectors.json is stale (first difference at line ${i + 1}); run node accept/conformance/export.mjs`);
  }
});

test("GATE-10: the vectors carry public keys only", () => {
  const privateMembers = [];
  JSON.parse(text, (k, v) => { if (["d", "p", "q", "dp", "dq", "qi", "k"].includes(k)) privateMembers.push(k); return v; });
  assert.deepEqual(privateMembers, [], "no private JWK member anywhere");
});

test("GATE-10: the TypeScript Gate passes every case from the data alone", async () => {
  const tests = [];
  registerConformance(V, { test: (name, fn) => tests.push({ name, fn }) });
  const failed = [];
  for (const t of tests) { try { await t.fn(); } catch (e) { failed.push(`${t.name}: ${e.message}`); } }
  assert.deepEqual(failed, []);
  const steps = V.cases.reduce((n, c) => n + c.steps.length, 0);
  const attacks = V.cases.reduce((n, c) => n + c.steps.filter((s) => s.expect === "rejected").length, 0);
  const n = (src) => V.cases.filter((c) => c.source === src).length;
  console.log(`GATE-10: ${V.cases.length} cases (${n("GATE-7")} attacks, ${n("STD-2")} STD-2 groups, ${n("STD-1")} WG vectors), ${steps} steps (${attacks} refused) from accept/conformance/vectors.json on Node; Deno and workerd in NEUT-1`);
});

test("GATE-10: the runner refuses wrong vectors", async () => {
  const pick = (id) => structuredClone(byId.get(id));
  const fails = async (c, re, what) => assert.rejects(() => runCase(c, V.defaults), re, what);
  let c = pick("replay--get");
  c.steps.find((s) => s.expect === "rejected").expect = "verified";
  await fails(c, /expected VERIFIED/, "an attack marked as a control");
  c = pick("replay--get");
  c.steps[0].reference.class = "UNVERIFIED";
  await fails(c, /reference answered UNVERIFIED/, "a reference that disagrees");
  c = pick("key-confusion--cimd-card-claims-victim-client-id");
  c.world.documents = [];
  await fails(c, /step 0 \(verified\)/, "a control that needs a document the world no longer serves");
  c = pick("clock-skew--long-lived");
  c.gates.main.directories = [];
  await fails(c, /step 0 \(verified\)/, "a Gate that knows no directory");
  c = pick("route-evasion--case-upper");
  c.steps.find((s) => s.expect === "rejected").raw.target = "/products";
  await fails(c, /GOT THROUGH|reference answered/, "an attack moved off the protected route");
  c = pick("wg-e2-1--signature-verifies");
  c.steps[0].signature.request.fields[2].value = c.steps[0].signature.request.fields[2].value.replace("RdNF", "RdNG");
  await fails(c, /did not verify/, "a WG vector with a flipped byte");
  c = pick("wg-e2-1--one-flipped-byte");
  c.steps[0].signature.request = pick("wg-e2-1--signature-verifies").steps[0].signature.request;
  await fails(c, /\(invalid\): verified/, "a tampered vector that is not tampered");
  c = pick("wg-e2-1--signature-verifies");
  c.steps[0].reference.identifier = "https://elsewhere.test";
  await fails(c, /the reference is/, "a vector attributed to another identifier");
  const std2 = (title) => structuredClone(V.cases.find((x) => x.group === title));
  c = std2("another key → never VERIFIED as the agent");
  c.steps.find((s) => s.classes?.[0] === "UNVERIFIED").classes = ["SPOOFED"];
  await fails(c, /expected class SPOOFED/, "a refusal in the wrong class (§10.8: an unknown keyid is UNVERIFIED)");
  c = std2("Signature-Agent dictionary key vs the signature's covered member and label");
  c.steps.find((s) => s.expect === "verified").identifier = "https://agent.example";
  await fails(c, /attributed to https:\/\/attacker\.example, expected https:\/\/agent\.example/, "a control attributed to the wrong member");
});
