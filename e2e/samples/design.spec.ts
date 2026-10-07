// Design screenshots and motion video from the sample build. Runs only when DESIGN_SHOTS_DIR is set.
import { test } from "@playwright/test";
import { renameSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DESIGN_SHOTS_DIR;
test.skip(!dir, "Set DESIGN_SHOTS_DIR to capture design screenshots.");
test.setTimeout(180_000);

interface Entry { id: string; claim: string; verified_by: string; replaces: string[] }

test("home and lesson pages at 390 and 1280, light and dark, with video", async ({ browser, request }) => {
  const index = (await (await request.get("/index.json")).json()) as { lessons: Entry[] };
  const longest = [...index.lessons].sort((a, b) => b.claim.length - a.claim.length)[0]!;
  const proof = index.lessons.find((l) => l.verified_by === "proof")!;
  const source = index.lessons.find((l) => l.verified_by === "source" && l.replaces.length > 0) ?? index.lessons.find((l) => l.verified_by === "source")!;
  const pages: Record<string, string> = {
    home: "/",
    "lesson-test-long": `/lessons/${longest.id}/`,
    "lesson-proof": `/lessons/${proof.id}/`,
    "lesson-source-corrects": `/lessons/${source.id}/`,
    lessons: "/lessons/",
  };
  for (const width of [390, 1280]) {
    for (const colorScheme of ["light", "dark"] as const) {
      // Stills: reduced motion, so every animation shows its final state.
      const still = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      const page = await still.newPage();
      for (const [name, path] of Object.entries(pages)) {
        await page.goto(path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(dir!, `${name}-${width}-${colorScheme}.png`), fullPage: true });
      }
      await still.close();

      // Motion: the home page plays its moment once on load.
      const video = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 800 },
        colorScheme,
        recordVideo: { dir: dir!, size: { width, height: width === 390 ? 844 : 800 } },
      });
      const moving = await video.newPage();
      await moving.goto("/", { waitUntil: "networkidle" });
      await moving.waitForTimeout(6000);
      const path = await moving.video()!.path();
      await video.close();
      renameSync(path, join(dir!, `home-motion-${width}-${colorScheme}.webm`));
    }
  }
});
