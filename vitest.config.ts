// Vitest 4, pinned until @cloudflare/vitest-plugin supports a newer major (CLAUDE.md).
// Two projects: plain Node for packages, tools, and the site's build code; workerd for the Worker.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts", "apps/site/test/**/*.test.ts", ".claude/hooks/*.test.ts"],
        },
      },
      {
        // Runs inside workerd with the bindings from wrangler.jsonc, including the real ASSETS binding
        // over apps/site/dist. Build the site first: npm run build.
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["apps/worker/test/**/*.test.ts"],
          globalSetup: ["apps/worker/test/require-site-build.ts"],
        },
      },
    ],
  },
});
