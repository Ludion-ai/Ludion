// PUB-2 (−): what `npm publish` would send holds nothing that shouldn't leave, and every package is
// publishable as is. Per package of the set, from `npm pack --dry-run` (the exact file list):
//   - only its declared `files` + package.json, README.md, LICENSE; no tests, benches, fixtures,
//     key material, env files or identities (ludion.json)
//   - license Apache-2.0 and LICENSE byte-equal to the repository's; a real README
//   - repository/homepage/engines set; scoped packages public (publishConfig.access)
//   - bin files exist in the tarball and start with a node shebang; every export target is shipped
//   - every internal dependency is a package of the set at exactly its version (publishable in order)
// The checker is tested on a planted package first, so an empty pass is impossible.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, SET, BUNDLED, manifest, packList } from "./set.mjs";

const FORBIDDEN = [/(^|\/)test\//, /\.test\.[cm]?js$/, /(^|\/)bench\//, /(^|\/)fixtures?\//, /(^|\/)\.env/, /\.(pem|key|p12|pfx)$/, /(^|\/)ludion\.json$/, /(^|\/)node_modules\//];
const ALWAYS = new Set(["package.json", "README.md", "LICENSE"]);

/** Problems with one package, given its manifest, its packed file list and a reader for its files. */
export function problems(m, files, read, setManifests) {
  const out = [];
  const declared = m.files ?? [];
  if (!declared.length) out.push("no `files` field: npm would publish everything");
  for (const f of files) {
    if (FORBIDDEN.some((re) => re.test(f))) out.push(`forbidden file in the tarball: ${f}`);
    else if (!ALWAYS.has(f) && !declared.some((d) => (d.endsWith("/") ? f.startsWith(d) : f === d))) out.push(`undeclared file in the tarball: ${f}`);
  }
  for (const f of ALWAYS) if (!files.includes(f)) out.push(`missing ${f}`);
  if (m.license !== "Apache-2.0") out.push(`license is ${m.license}`);
  if (files.includes("LICENSE") && !read("LICENSE").equals(fs.readFileSync(path.join(ROOT, "LICENSE")))) out.push("LICENSE differs from the repository's");
  if (files.includes("README.md") && read("README.md").length < 200) out.push("README.md is a stub");
  if (!/github\.com\/Ludion-ai\/Ludion/.test(m.repository?.url ?? "")) out.push("repository.url missing");
  if (!m.homepage) out.push("homepage missing");
  if (!m.engines?.node) out.push("engines.node missing");
  if (m.private) out.push("private: true");
  if (m.name.startsWith("@") && m.publishConfig?.access !== "public") out.push("scoped package without publishConfig.access = public (npm would refuse or publish it restricted)");
  for (const [name, rel] of Object.entries(m.bin ?? {})) {
    const f = rel.replace(/^\.\//, "");
    if (!files.includes(f)) out.push(`bin ${name} → ${f} not in the tarball`);
    else if (!read(f).toString("utf8").startsWith("#!/usr/bin/env node")) out.push(`bin ${name} has no node shebang`);
  }
  const targets = [m.main, ...Object.values(typeof m.exports === "string" ? { ".": m.exports } : m.exports ?? {})].filter(Boolean);
  for (const t of targets) { const f = String(t).replace(/^\.\//, ""); if (!files.includes(f)) out.push(`export target ${f} not in the tarball`); }
  for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
    if (!(dep === "ludion" || dep.startsWith("@ludion/"))) continue;
    const target = setManifests.find((s) => s.name === dep);
    if (!target) out.push(`depends on ${dep}, which is not in the publish set`);
    else if (range !== target.version) out.push(`depends on ${dep}@${range}, but the set publishes ${target.version}`);
  }
  return out;
}

test("PUB-2: the checker catches what it must (planted package)", () => {
  const good = { name: "@ludion/x", version: "0.0.1", license: "Apache-2.0", homepage: "h", engines: { node: ">=20" }, publishConfig: { access: "public" },
    repository: { url: "git+https://github.com/Ludion-ai/Ludion.git" }, files: ["src/", "bin/", "README.md", "LICENSE"], bin: { x: "bin/x.mjs" }, exports: { ".": "./src/i.mjs" } };
  const files = ["package.json", "README.md", "LICENSE", "src/i.mjs", "bin/x.mjs"];
  const read = (f) => (f === "LICENSE" ? fs.readFileSync(path.join(ROOT, "LICENSE")) : f === "README.md" ? Buffer.alloc(300, "a") : Buffer.from("#!/usr/bin/env node\n"));
  assert.deepEqual(problems(good, files, read, [good]), [], "a clean package passes");
  const cases = [
    [{ ...good }, [...files, "test/a.test.mjs"], "forbidden"], [{ ...good }, [...files, "src/k.pem"], "forbidden"],
    [{ ...good }, [...files, "fixtures/log.gz"], "forbidden"], [{ ...good }, [...files, "ludion.json"], "forbidden"],
    [{ ...good }, [...files, "notes.txt"], "undeclared"], [{ ...good, files: undefined }, files, "no `files`"],
    [{ ...good, publishConfig: undefined }, files, "publishConfig"], [{ ...good, license: "MIT" }, files, "license is"],
    [{ ...good, private: true }, files, "private"], [{ ...good, bin: { x: "bin/y.mjs" } }, files, "not in the tarball"],
    [{ ...good, dependencies: { "@ludion/y": "0.0.1" } }, files, "not in the publish set"],
    [{ ...good, dependencies: { "@ludion/x": "0.0.2" } }, files, "but the set publishes"],
    [{ ...good }, files.filter((f) => f !== "LICENSE"), "missing LICENSE"],
  ];
  for (const [m, f, expect] of cases) assert.ok(problems(m, f, read, [good]).some((p) => p.includes(expect)), `caught: ${expect} (${f.at(-1)})`);
  const shebangless = (f) => (f === "bin/x.mjs" ? Buffer.from("console.log(1)") : read(f));
  assert.ok(problems(good, files, shebangless, [good]).some((p) => p.includes("shebang")), "caught: no shebang");
});

test("PUB-2: every package of the publish set ships only what it declares, and is publishable as is", () => {
  const manifests = SET.map(manifest);
  assert.ok(manifests.some((m) => m.name === "ludion" && m.bin?.ludion), "the unscoped `ludion` (npx ludion) is in the set");
  const report = [];
  for (const dir of SET) {
    const m = manifest(dir), { files } = packList(dir);
    const read = (f) => fs.readFileSync(path.join(ROOT, "packages", dir, f));
    const p = problems(m, files, read, manifests);
    report.push(`${m.name}@${m.version}: ${files.length} files`);
    assert.deepEqual(p, [], `${m.name}: ${p.join("; ")}`);
  }
  console.log(`PUB-2: ${report.join(", ")}`);
});

test("PUB-2: only the set can be published; the bundled packages and every other package are private (ADR-036)", () => {
  const dirs = fs.readdirSync(path.join(ROOT, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, "packages", e.name, "package.json"))).map((e) => e.name);
  const open = dirs.filter((d) => !SET.includes(d) && !manifest(d).private);
  assert.deepEqual(open, [], "a package outside the set is publishable");
  for (const d of BUNDLED) assert.ok(dirs.includes(d) && manifest(d).private, `${d} is bundled and private`);
  for (const d of SET) assert.ok(!manifest(d).private, `${d} is in the set, so it is not private`);
  const services = path.join(ROOT, "services");
  for (const d of fs.existsSync(services) ? fs.readdirSync(services) : []) {
    const p = path.join(services, d, "package.json");
    if (fs.existsSync(p)) assert.ok(JSON.parse(fs.readFileSync(p, "utf8")).private, `services/${d} is private`);
  }
});
