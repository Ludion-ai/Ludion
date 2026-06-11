/**
 * Gate 2 decisions Q2 (additional acceptance condition): the Gate 1 guarantee
 * "server-routed sessions download zero bytes of engine code" must survive
 * the build step. Verifies, against the built dist:
 *
 *   1. no WebLLM code is bundled into dist (the engine must not ride along),
 *   2. the dynamic `import("@mlc-ai/web-llm")` survived bundling as a true
 *      dynamic import of the external specifier,
 *   3. no *static* import of the engine exists in dist (a static import would
 *      make every consumer bundle pull the engine into the critical path).
 *
 * Exits non-zero with a reason on any violation. Run via `pnpm verify-dist`
 * (also wired into prepublishOnly and CI).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const distDir = new URL("../dist/", import.meta.url).pathname;

// The engine's own bundle (lib/index.js in @mlc-ai/web-llm@0.2.84) is ~6.4 MB;
// ludion's entire dist is ~25 KB. Any dist file above this ceiling means
// something large (almost certainly the engine) was inlined.
const MAX_DIST_FILE_BYTES = 300 * 1024;

const jsFiles = readdirSync(distDir).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error("verify-dist: no .js files in dist/ — run `pnpm build` first");
  process.exit(1);
}

let dynamicImportSeen = false;
const failures = [];

for (const file of jsFiles) {
  const src = readFileSync(join(distDir, file), "utf-8");

  // 1. Engine code must not be inlined. These identifiers belong to the
  //    engine's *internals* (verified present in @mlc-ai/web-llm@0.2.84
  //    lib/index.js and absent from ludion's own source/dist). Note that
  //    "MLCEngine"/"webllm" are NOT usable as markers: ludion's own lazy-load
  //    call site legitimately reads `webllm.CreateMLCEngine` off the
  //    dynamically imported namespace.
  for (const marker of ["prebuiltAppConfig", "reloadInternal", "model_lib", "GenerationConfig"]) {
    if (src.includes(marker)) {
      failures.push(`${file}: contains "${marker}" — WebLLM code appears to be bundled in`);
    }
  }

  // 1b. Size guard: the engine bundle is ~6.4 MB, ludion's dist ~25 KB.
  const { size } = statSync(join(distDir, file));
  if (size > MAX_DIST_FILE_BYTES) {
    failures.push(`${file}: ${size} bytes exceeds ${MAX_DIST_FILE_BYTES} — large code inlined into dist`);
  }

  // 2./3. The engine specifier may appear ONLY as a dynamic import.
  const specifier = "@mlc-ai/web-llm";
  const staticImportRe = /(^|\n)\s*import\s[^;]*?from\s*["']@mlc-ai\/web-llm["']/;
  const dynamicImportRe = /import\(\s*["']@mlc-ai\/web-llm["']\s*\)/;
  if (staticImportRe.test(src)) {
    failures.push(`${file}: static import of ${specifier} — engine on the critical path`);
  }
  if (dynamicImportRe.test(src)) {
    dynamicImportSeen = true;
  } else if (src.includes(specifier)) {
    failures.push(`${file}: ${specifier} referenced but not via a plain dynamic import()`);
  }
}

if (!dynamicImportSeen) {
  failures.push(`dynamic import("@mlc-ai/web-llm") not found in any dist file — lazy load lost in build`);
}

if (failures.length > 0) {
  console.error("verify-dist: FAILED");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(`verify-dist: OK (${jsFiles.length} js file(s); engine external, dynamic import preserved)`);
