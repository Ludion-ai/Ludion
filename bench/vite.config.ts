import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Inject the exact pinned engine versions from package.json so the schema's
// engine_version field always reflects what was actually installed.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { dependencies: Record<string, string> };

export default defineConfig({
  // HTTPS is required: WebGPU is [SecureContext]-only, and iOS Safari has no
  // override for plain-HTTP LAN origins. basic-ssl gives a self-signed cert;
  // the operator accepts the warning once on-device.
  plugins: [basicSsl()],
  server: {
    host: true, // expose on LAN so the iPhone can reach the dev server
  },
  define: {
    __ENGINE_VERSIONS__: JSON.stringify({
      webllm: pkg.dependencies["@mlc-ai/web-llm"],
      transformersjs: pkg.dependencies["@huggingface/transformers"],
      wllama: pkg.dependencies["@wllama/wllama"],
    }),
  },
  optimizeDeps: {
    // wllama ships WASM workers that must not be pre-bundled.
    exclude: ["@wllama/wllama"],
  },
  build: {
    target: "es2022",
    // Engines are heavy; keep the warning honest but not noisy.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // Multi-page (Gate 4 ②): the measure app + the public /data dashboard.
      // Cloudflare Pages serves dist/data.html at the /data route.
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        data: fileURLToPath(new URL("./data.html", import.meta.url)),
      },
    },
  },
});
