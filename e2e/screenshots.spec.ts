// Design screenshots for review (docs/decisions.md, Site). Not part of CI: runs only when SCREENSHOTS_DIR is set.
//   SCREENSHOTS_DIR=<folder> npm run test:e2e -- screenshots
import { test } from "@playwright/test";
import { join } from "node:path";

const dir = process.env.SCREENSHOTS_DIR;
const WIDTHS = [390, 1280];
const SCHEMES = ["light", "dark"] as const;

test.skip(!dir, "Set SCREENSHOTS_DIR to capture design screenshots.");

test("capture lesson, teacher, home, lessons, and 404 pages", async ({ browser, request }) => {
  const index = (await (await request.get("/index.json")).json()) as { lessons: { id: string }[]; teachers: Record<string, { login: string }> };
  const pages: Record<string, string> = {
    home: "/",
    lesson: `/lessons/${index.lessons[0]!.id}/`,
    teacher: `/@${Object.values(index.teachers)[0]!.login.toLowerCase()}`,
    lessons: "/lessons/",
    "404": "/no-such-page/",
  };
  for (const width of WIDTHS) {
    for (const colorScheme of SCHEMES) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      for (const [name, path] of Object.entries(pages)) {
        await page.goto(path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(dir!, `${name}-${width}-${colorScheme}.png`), fullPage: true });
      }
      if (width === 1280) {
        // The verified moment, for review: the same chip before (checking) and after (verified).
        await page.goto(pages.lesson!, { waitUntil: "networkidle" });
        const box = await page.evaluate(() => {
          const verified = document.querySelector<HTMLElement>(".chip.verified")!;
          const row = document.createElement("div");
          row.id = "moment";
          row.style.cssText = "display:flex;gap:16px;align-items:center;padding:16px;background:var(--bg)";
          const checking = verified.cloneNode(true) as HTMLElement;
          checking.classList.replace("verified", "checking");
          checking.lastChild!.textContent = "Checking";
          row.append(checking, verified.cloneNode(true));
          document.body.prepend(row);
          return true;
        });
        if (box) await page.locator("#moment").screenshot({ path: join(dir!, `moment-${colorScheme}.png`) });
      }
      await context.close();
    }
  }
});
