import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://ludion.ai",
  output: "static",
  build: { format: "directory" },
  vite: {
    // Never inline scripts: the CSP allows script-src 'self' only.
    build: { assetsInlineLimit: 0 },
  },
});
