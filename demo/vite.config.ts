import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // HTTPS + LAN host, same as bench: WebGPU is [SecureContext]-only and the
  // phones reach the dev server over the existing tunnel / LAN.
  plugins: [basicSsl()],
  server: {
    host: true,
  },
  build: {
    target: "es2022",
    // The dynamically imported WebLLM chunk is heavy by design (Q2); it is
    // only fetched after a local routing decision.
    chunkSizeWarningLimit: 6500,
    rollupOptions: {
      // Multi-page (Gate 6-B): the chat demo + the /savings dashboard. The
      // savings entry imports only `ludion-router/savings` (no engine), so its
      // chunk stays tiny and pulls zero inference code.
      input: {
        // Public, login-free landing at the root (the HN front door). Pulls no
        // engine code on load; the in-page demo lazy-imports ludion-router only
        // on the visitor's click.
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        savings: fileURLToPath(new URL("./savings.html", import.meta.url)),
        // The logged-in workspace (Gate 2b), moved off the root to /app. Same-
        // origin so the 2a session cookie applies; its own dark+red stylesheet,
        // isolated from the public pages. Imports only ludion-router/savings +
        // /registry (no engine).
        app: fileURLToPath(new URL("./app.html", import.meta.url)),
        blog: fileURLToPath(new URL("./blog/index.html", import.meta.url)),
        "blog-webgpu-reports-vs-reality": fileURLToPath(
          new URL("./blog/webgpu-reports-vs-reality/index.html", import.meta.url),
        ),
      },
    },
  },
});
