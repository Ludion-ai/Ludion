import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

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
  },
});
