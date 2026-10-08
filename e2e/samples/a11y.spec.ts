// axe on every page of the sample build, light and dark: long claims, long logins, every evidence kind.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const colorScheme of ["light", "dark"] as const) {
  test(`axe finds no violations on any sample page (${colorScheme})`, async ({ browser, request }) => {
    const index = (await (await request.get("/index.json")).json()) as { lessons: { id: string }[] };
    const paths = ["/", "/lessons/", ...index.lessons.map((l) => `/lessons/${l.id}/`)];
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      for (const path of paths) {
        await page.goto(path);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const summary = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
        expect(summary, `axe on ${path} at ${width}px (${colorScheme})`).toEqual([]);
      }
      await context.close();
    }
  });
}
