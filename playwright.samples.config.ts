// Design checks against the sample build (apps/site/samples), served by astro preview. Never the real lessons.
//   npm run build:samples -w @ludion/site
//   npx playwright test -c playwright.samples.config.ts                     (axe on every sample page)
//   DESIGN_SHOTS_DIR=<folder> npx playwright test -c playwright.samples.config.ts design   (screenshots + video)
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/samples",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4321" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview:samples -w @ludion/site",
    url: "http://127.0.0.1:4321/index.json",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
