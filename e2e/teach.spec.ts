// /teach shows the whole lesson, claim and every piece of evidence in full, and the name it will be signed as,
// before Teach can be pressed (site.md, /teach). The Worker's API is faked here; its own tests cover it.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const draft = {
  subject: "python",
  version: ">=3.12",
  claim: "Python 3.12 removed the distutils module from the standard library (PEP 632); use setuptools or packaging instead.",
  evidence: [
    { run: { runner: "python", code: "import importlib.util, sys\nassert sys.version_info >= (3, 12)\nassert importlib.util.find_spec('distutils') is None" } },
    { source: { url: "https://peps.python.org/pep-0632/", quote: "The distutils package is deprecated and slated for removal in Python 3.12." } },
  ],
};
const link = `/teach/#d=${Buffer.from(JSON.stringify(draft)).toString("base64url")}`;

async function fakeApi(page: Page, session: { status: number; body: unknown }) {
  await page.route("**/api/session", (r) => r.fulfill({ status: session.status, json: session.body }));
  await page.route("**/api/check", (r) => r.fulfill({ status: 200, json: { ok: true, verified_by: "test", sources: [{ url: draft.evidence[1]!.source!.url, found: true }] } }));
}

async function noViolations(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`), what).toEqual([]);
}

test("signed in: the whole lesson, the signer, the consent line, then Teach after the check", async ({ page }) => {
  await fakeApi(page, { status: 200, body: { login: "alice", avatar_url: "" } });
  await page.goto(link);
  const lesson = page.locator("#teach-draft");
  await expect(lesson).toContainText(draft.claim);
  await expect(lesson).toContainText("assert importlib.util.find_spec('distutils') is None");
  await expect(lesson).toContainText(draft.evidence[1]!.source!.quote);
  await expect(lesson).toContainText("https://peps.python.org/pep-0632/");
  await expect(lesson).toContainText(">=3.12");
  await expect(page.locator("#teach-signing-as")).toHaveText("You are signing as @alice.");
  await expect(page.locator(".consent")).toBeVisible();
  await expect(page.locator("#teach-checks")).toContainText("Quote found on peps.python.org");
  await expect(page.locator("#teach-submit")).toBeEnabled();
  await noViolations(page, "signing view");
});

test("signed out with a draft: the whole lesson and a sign-in button that keeps it", async ({ page }) => {
  await fakeApi(page, { status: 401, body: { error: "signin_required" } });
  await page.goto(link);
  await expect(page.locator("#teach-draft")).toContainText(draft.claim);
  await expect(page.locator("#teach-signin-link")).toHaveText("Sign in with GitHub to sign this lesson");
  await expect(page.locator("#teach-sources-later")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("ludion:draft"))).toContain("distutils");
  await noViolations(page, "signed out with a draft");
});

test("closed: says teaching opens soon and offers no sign-in", async ({ page }) => {
  await page.goto(link);
  await expect(page.locator("#teach-closed")).toHaveText("Teaching on Ludion opens soon. Nothing was saved.");
  await expect(page.locator("#teach-signin")).toBeHidden();
  await expect(page.locator("#teach-sign")).toBeHidden();
});

test("a draft's text is shown as text, never as markup", async ({ page }) => {
  await fakeApi(page, { status: 200, body: { login: "alice", avatar_url: "" } });
  const hostile = { ...draft, claim: 'Python 3.12 removed distutils <img src=x onerror="window.pwned=1">.' };
  await page.goto(`/teach/#d=${Buffer.from(JSON.stringify(hostile)).toString("base64url")}`);
  await expect(page.locator("#draft-claim")).toHaveText(hostile.claim);
  expect(await page.locator("#teach-draft img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});
