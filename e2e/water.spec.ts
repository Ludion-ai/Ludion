// The home page's water: text contrast over the canvas, and the home JavaScript budget.
// axe can't see text drawn over a canvas, so this measures it directly: hide the text, step the water's clock,
// screenshot, and take the worst background pixel under each text box (site.md, Budgets; water.js).
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { gzipSync } from "node:zlib";

const MOMENTS = 40;
const STEP_MS = 300; // 40 moments over 12 s: before, during, and after the ring
const SMALL_TEXT_MIN = 4.5;
const LARGE_TEXT_MIN = 3;

interface Target {
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  color: [number, number, number];
  large: boolean;
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every piece of text in the replay: its box, its color, and whether WCAG counts it as large. */
async function targets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const groups: [string, string][] = [
      ["claim", ".replay .text"],
      ["teacher", ".replay .by"],
      ["date", ".replay .state time"],
      ["subject", ".replay .state .tag"],
      ["log", ".replay .log .line"],
      ["caption", ".replay .caption"],
    ];
    const out: Target[] = [];
    for (const [name, selector] of groups) {
      document.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const style = getComputedStyle(el);
        const [cr, cg, cb] = style.color.match(/\d+(\.\d+)?/g)!.map(Number) as [number, number, number];
        const size = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        out.push({
          name: `${name}${i ? ` ${i + 1}` : ""}`,
          rect: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
          color: [cr, cg, cb],
          large: size >= 24 || (bold && size >= 18.66),
        });
      });
    }
    return out;
  }) as Promise<Target[]>;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`text over the water keeps its contrast (${colorScheme})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
    const page = await context.newPage();
    await page.clock.install({ time: 0 });
    await page.goto("/");
    const hasWater = await page.evaluate(() => document.documentElement.classList.contains("has-water"));
    test.skip(!hasWater, "No WebGL2 in this browser: the replay is plain design B, which axe covers.");

    // Let the text finish arriving (CSS animations run on real time), then record where every piece of text is.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === "finished" || a.playState === "idle"));
    const boxes = await targets(page);
    expect(boxes.length).toBeGreaterThan(4);

    // Hide the text, keep the layout: only the water and the page remain under each box.
    await page.addStyleTag({ content: ".replay .grid, .replay .caption { visibility: hidden !important; }" });
    const worst = new Map<string, number>();
    for (let moment = 0; moment < MOMENTS; moment++) {
      await page.clock.runFor(STEP_MS);
      const shot = PNG.sync.read(await page.screenshot({ fullPage: true }));
      for (const box of boxes) {
        let min = Infinity;
        const x0 = Math.max(0, Math.floor(box.rect.x)), x1 = Math.min(shot.width, Math.ceil(box.rect.x + box.rect.width));
        const y0 = Math.max(0, Math.floor(box.rect.y)), y1 = Math.min(shot.height, Math.ceil(box.rect.y + box.rect.height));
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * shot.width + x) * 4;
            min = Math.min(min, contrast(box.color, [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!]));
          }
        }
        worst.set(box.name, Math.min(worst.get(box.name) ?? Infinity, min));
      }
    }

    const report = boxes.map((b) => `${b.name}: ${worst.get(b.name)!.toFixed(2)} (needs ${b.large ? LARGE_TEXT_MIN : SMALL_TEXT_MIN})`);
    console.log(`Worst contrast over the water (${colorScheme}):\n  ${report.join("\n  ")}`);
    const failing = boxes.filter((b) => worst.get(b.name)! < (b.large ? LARGE_TEXT_MIN : SMALL_TEXT_MIN));
    expect(failing.map((b) => report[boxes.indexOf(b)]), "text whose background got too close to its color").toEqual([]);
    await context.close();
  });
}

test("the home page's JavaScript stays within 60 KB gzipped", async ({ page }) => {
  const scripts: Buffer[] = [];
  page.on("response", async (res) => {
    if (res.request().resourceType() === "script") scripts.push(await res.body());
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const total = scripts.reduce((sum, body) => sum + gzipSync(body).length, 0);
  console.log(`Home JavaScript: ${scripts.length} file(s), ${(total / 1024).toFixed(1)} KB gzipped`);
  expect(scripts.length).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(60 * 1024);
});
