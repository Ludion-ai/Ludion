// End-to-end checks against the built site served by `wrangler dev` (docs/decisions.md, test.yml).
// Build first: npm run build. Then: npm run test:e2e.
import { defineConfig, devices } from "@playwright/test";

const PORT = 8787;

export default defineConfig({
  testDir: "e2e",
  // e2e/samples runs against the design samples (playwright.samples.config.ts), never here.
  testIgnore: ["samples/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --show-interactive-dev-session=false`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
