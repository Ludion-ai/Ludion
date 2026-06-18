import { defineConfig } from "tsup";

/**
 * Publish build (Gate 2 decisions Q2):
 * - `@ludion/shared` is bundled into dist (repo-internal package, not on npm),
 * - `@mlc-ai/web-llm` stays external so the dynamic `import()` in local.ts
 *   survives the bundle — server-routed sessions must keep downloading zero
 *   bytes of engine code (Gate 1 guarantee, re-verified by verify-dist.mjs),
 * - `policy.v0.json` is inlined.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/savings.ts", "src/openai.ts"],
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  // NOTE: inlining @ludion/shared *types* into dist/index.d.ts relies on the
  // tsconfig `paths` mapping for "@ludion/shared" — without it the dts build
  // leaks `import ... from '@ludion/shared'`, which consumers cannot resolve
  // (the package is repo-internal). Caught by the packed-tarball smoke test.
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@mlc-ai/web-llm"],
  noExternal: ["@ludion/shared"],
});
