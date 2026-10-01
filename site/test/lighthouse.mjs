// Lighthouse (mobile, its default: Moto G Power emulation, simulated slow 4G) for the site oracles
// (WEB-1, WEB-9). The browser is the Chromium build that the site's playwright-core pins (the same
// cache WEB-4/5/6 use), driven through the DevTools port. lighthouse is pinned in site/package.json.
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { SITE, ensureDeps } from "../build.mjs";
import { launchChromium } from "./browser.mjs";

export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
export const MIN_SCORE = 95;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Start one browser with a DevTools port; audit(url) returns { url, scores: {category: 0..100}, failing: [...] }. */
export async function lighthouseRunner() {
  ensureDeps();
  const port = await freePort();
  const browser = await launchChromium({ args: [`--remote-debugging-port=${port}`] });
  const { default: lighthouse } = await import(pathToFileURL(path.join(SITE, "node_modules", "lighthouse", "core", "index.js")).href);
  async function audit(url) {
    const r = await lighthouse(url, { port, output: "json", logLevel: "error", onlyCategories: CATEGORIES });
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round((r.lhr.categories[c]?.score ?? 0) * 100)]));
    const failing = [];
    for (const c of CATEGORIES) {
      if (scores[c] >= MIN_SCORE) continue;
      const refs = r.lhr.categories[c]?.auditRefs ?? [];
      const low = refs.map((a) => r.lhr.audits[a.id]).filter((a) => a && a.score != null && a.score < 0.9 && a.scoreDisplayMode !== "informative")
        .map((a) => `${a.id} ${a.score}${a.displayValue ? ` (${a.displayValue})` : ""}`).slice(0, 6);
      failing.push(`${c} ${scores[c]}: ${low.join("; ")}`);
    }
    if (r.lhr.runtimeError) failing.push(`runtime error: ${r.lhr.runtimeError.code} ${r.lhr.runtimeError.message}`);
    return { url, scores, failing };
  }
  return { audit, close: () => browser.close() };
}
