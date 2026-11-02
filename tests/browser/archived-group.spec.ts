import { expect, test } from "@playwright/test";

test("an archived session stays listed, opens again and comes back when used", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&safeClose");
  const cards = page.getByRole("button", { name: /^Prepare the handoff/ });
  await expect(cards.first()).toBeVisible();
  await cards.first().click();
  const group = page.locator("[data-fork-archived]");
  await expect(group).toHaveCount(0);

  // Close it: gone from the main list, still listed under Archived.
  await page.locator("[data-fork-safe-close]:visible").click();
  const header = group.getByRole("button", { name: /^Archived/ });
  await expect(header).toContainText("1");
  const stored = group.getByRole("button", { name: /^Prepare the handoff/ });
  await expect(stored).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("archived-group.png") });

  // Collapsing it holds until the user opens it again, across a reload.
  await header.click();
  await expect(stored).toHaveCount(0);
  await page.reload();
  await cards.first().click();
  await page.locator("[data-fork-safe-close]:visible").click();
  await expect(header).toContainText("1");
  await expect(stored).toHaveCount(0);
  await header.click();
  await expect(stored).toHaveCount(1);

  // Reading it leaves it archived.
  await stored.click();
  await expect(page.getByText("This preview uses the real MonoCode app").first()).toBeVisible();
  await expect(header).toContainText("1");

  // Sending a message takes it out of the archive.
  const composer = page.locator("textarea:visible").first();
  await composer.fill("One more thing");
  await composer.press("Enter");
  await expect(group).toHaveCount(0);
});
