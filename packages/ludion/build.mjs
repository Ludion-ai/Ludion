#!/usr/bin/env node
// `ludion` is the one package on npm (ADR-036) and installs alone (PUB-3): at prepack, the CLI's
// code and the Gate's — the packages in vendored.mjs — are copied into lib/@ludion/<name>/ (each
// package's declared `files`), and every `@ludion/...` import in it is rewritten to the relative
// path of the file that package's `exports` names. The tarball then needs no @ludion/* from npm;
// its `exports` give `ludion/diver` and `ludion/gate/{node,next,workers}`.
// At postpack (`--clean`) lib/ is removed: the repository never holds a copy (CRY-1 and REG-4 see
// the sources only). Fails, and packs nothing, if an internal import cannot be resolved, or if the
// copied code needs a third-party package that `ludion` does not depend on.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(HERE, "..");
const LIB = path.join(HERE, "lib");
import { VENDORED } from "./vendored.mjs";
export { VENDORED };

if (process.argv.includes("--clean")) { fs.rmSync(LIB, { recursive: true, force: true }); process.exit(0); }

const own = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
const pkgs = new Map(VENDORED.map((dir) => {
  const m = JSON.parse(fs.readFileSync(path.join(PACKAGES, dir, "package.json"), "utf8"));
  return [m.name, { dir, m }];
}));

/** `@ludion/x` or `@ludion/x/sub` → the absolute path under lib/ of the file its exports name. */
function target(spec) {
  const m = /^(@ludion\/[a-z0-9-]+)(\/.+)?$/.exec(spec);
  const p = m && pkgs.get(m[1]);
  if (!p) throw new Error(`${spec}: not one of the vendored packages (${[...pkgs.keys()].join(", ")})`);
  const exp = typeof p.m.exports === "string" ? { ".": p.m.exports } : p.m.exports ?? {};
  const t = exp[m[2] ? `.${m[2]}` : "."];
  if (typeof t !== "string") throw new Error(`${spec}: ${p.m.name} exports no such path`);
  return path.join(LIB, ...p.m.name.split("/"), t);
}

fs.rmSync(LIB, { recursive: true, force: true });
for (const { dir, m } of pkgs.values()) {
  for (const entry of m.files ?? []) {
    if (entry === "README.md" || entry === "LICENSE") continue;
    const from = path.join(PACKAGES, dir, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(LIB, ...m.name.split("/"), entry), { recursive: true });
  }
}

const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const builtins = new Set(builtinModules);
const needed = new Set();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const file of walk(LIB).filter((f) => f.endsWith(".mjs"))) {
  const src = fs.readFileSync(file, "utf8");
  const out = src.replace(SPEC, (all, lead, q, spec) => {
    if (spec.startsWith("@ludion/")) {
      let rel = path.relative(path.dirname(file), target(spec)).split(path.sep).join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${lead}${q}${rel}${q}`;
    }
    if (!spec.startsWith(".") && !spec.startsWith("node:") && !builtins.has(spec)) needed.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    return all;
  });
  if (/["']@ludion\//.test(out.replace(/\/\/.*$/gm, ""))) throw new Error(`${path.relative(HERE, file)}: an @ludion import left unresolved`);
  if (out !== src) fs.writeFileSync(file, out);
}
// A peer (next for ludion/gate/next) comes from the app; anything else must be a dependency.
const missing = [...needed].filter((d) => !own.dependencies?.[d] && !own.peerDependencies?.[d]);
if (missing.length) { fs.rmSync(LIB, { recursive: true, force: true }); throw new Error(`the vendored code needs ${missing.join(", ")}: add to ludion's dependencies`); }
console.error(`ludion: vendored ${[...pkgs.keys()].join(", ")} into lib/ (${walk(LIB).length} files)`);
