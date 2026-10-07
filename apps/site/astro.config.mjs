import { defineConfig } from "astro/config";

// LUDION_SAMPLES=1 builds the design samples (apps/site/samples) into dist-samples, never into dist,
// so a sample build can't end up in the deployed assets.
const samples = process.env.LUDION_SAMPLES === "1";

export default defineConfig({
  site: "https://ludion.ai",
  output: "static",
  outDir: samples ? "./dist-samples" : "./dist",
  build: { format: "directory" },
  vite: {
    // Never inline scripts: the CSP allows script-src 'self' only.
    build: { assetsInlineLimit: 0 },
  },
});
