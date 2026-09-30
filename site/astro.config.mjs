// ludion.ai — a static site that can be put anywhere (ADR-040). English at the root, Japanese at /ja/.
// Every Gate denial links to https://ludion.ai/e/<code>; those pages live in src/content/docs/e/.
// `build.format: "preserve"` + no trailing slash: /e/signature_required is e/signature_required.html,
// which static hosts (Cloudflare Pages, Vercel cleanUrls, nginx try_files) serve without a redirect,
// and links and canonical URLs carry no ".html" ("file" would add it).
// /scan runs the CLI's own scan code (packages/scan, and the two browser-safe gate-core modules it
// uses) straight from the repository: aliased here, since the site is not a root workspace.
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const pkg = (p) => fileURLToPath(new URL(`../packages/${p}`, import.meta.url));

export default defineConfig({
  site: process.env.LUDION_SITE_URL ?? "https://ludion.ai",
  trailingSlash: "never",
  build: { format: "preserve" },
  vite: {
    resolve: {
      alias: [
        { find: /^@ludion\/scan\/web$/, replacement: pkg("scan/src/web.mjs") },
        { find: /^@ludion\/gate-core\/(agents|route)$/, replacement: `${pkg("gate-core/src/")}$1.mjs` },
      ],
    },
  },
  integrations: [
    starlight({
      title: "Ludion",
      description: "A neutral checkpoint that verifies AI agents' accountability, on Web Bot Auth (RFC 9421).",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Ludion-ai/Ludion" }],
      sidebar: [
        { slug: "gate" },
        { label: "Gate errors", translations: { ja: "Gate のエラー" }, items: [{ autogenerate: { directory: "e" } }] },
      ],
      routeMiddleware: "./src/route-data.mjs",
      lastUpdated: false,
      pagefind: true,
    }),
  ],
});
