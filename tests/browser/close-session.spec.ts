import { expect, test } from "@playwright/test";

test("closes a session from its reply once nothing is left to do", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&safeClose");
  // Every sample project has a session with this title.
  const cards = page.getByRole("button", { name: /^Prepare the handoff/ });
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  await cards.first().click();
  const close = page.locator("[data-fork-safe-close]:visible");
  await expect(close).toHaveText("Close session");
  await page.screenshot({ path: testInfo.outputPath("close-session.png") });

  // Text in the composer means the person is still going.
  const composer = page.locator("textarea:visible").first();
  await composer.fill("One more thing");
  await expect(close).toHaveCount(0);
  await composer.fill("");
  await expect(close).toHaveCount(1);

  await close.click();
  await expect(cards).toHaveCount(before - 1);
  await expect(close).toHaveCount(0);
});

test("offers no close button without the safe line", async ({ page }) => {
  await page.goto("/tests/browser/workspace-performance.html?projects");
  await page.getByRole("button", { name: /Prepare the handoff/ }).first().click();
  await expect(page.getByText("This preview uses the real MonoCode app").first()).toBeVisible();
  await expect(page.locator("[data-fork-safe-close]")).toHaveCount(0);
});
