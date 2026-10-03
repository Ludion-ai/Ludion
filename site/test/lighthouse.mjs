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

/**
 * Start one browser with a DevTools port. audit(url) returns { url, scores: {category: 0..100}, failing: [...] }
 * for one run; auditMedian(url, runs) runs it `runs` times and judges the median score of each category.
 * Lighthouse's performance score moves between runs on a busy machine (Google's own advice is the median
 * of several). The bar stays MIN_SCORE: one slow run no longer fails a page, a page slow in most runs does.
 */
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
    return { url, scores, failing, runtimeError: !!r.lhr.runtimeError };
  }
  /** The median of `runs` audits per category; failing names each category whose median is below the bar. */
  async function auditMedian(url, runs = 3) {
    const all = [];
    for (let i = 0; i < runs; i++) all.push(await audit(url));
    const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c, median(all.map((r) => (r.runtimeError ? 0 : r.scores[c])))]));
    const failing = [];
    for (const c of CATEGORIES) {
      if (scores[c] >= MIN_SCORE) continue;
      // The run that scored the median says why.
      const at = all.find((r) => !r.runtimeError && r.scores[c] === scores[c]) ?? all.find((r) => r.runtimeError) ?? all[0];
      failing.push(`${c} median ${scores[c]} of ${all.map((r) => (r.runtimeError ? 0 : r.scores[c])).join("/")}: ${at.failing.find((x) => x.startsWith(c) || x.startsWith("runtime")) ?? ""}`);
    }
    return { url, scores, failing, runs: all.map((r) => r.scores) };
  }
  return { audit, auditMedian, close: () => browser.close() };
}
