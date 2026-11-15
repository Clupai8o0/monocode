import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`live fold status, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 520 });
    await page.goto(
      `/tests/browser/live-working-status.html?scene=fold&theme=${theme}`,
    );
    await expect(page.getByText(/Opus 5\.5/)).toBeVisible();
    await expect(page.getByText(/Thinking/)).toBeVisible();
    await expect(
      page.getByText(/checking whether I'm still working/i),
    ).toBeVisible();
    await page.screenshot({
      path: `${dir}/live-fold-${theme}.png`,
    });
  });

  test(`agents tray with live steps and stoppable job, ${theme}`, async ({
    page,
  }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(
      `/tests/browser/live-working-status.html?scene=agents&theme=${theme}`,
    );
    await expect(page.locator("[data-fork-agents-board]")).toBeVisible();
    await expect(page.getByText("Search the auth module").first()).toBeVisible();
    // Running agents open onto their steps so the work is visible without a click.
    await expect(
      page.getByTitle("Run npm test -- --run src/features/auth/"),
    ).toBeVisible();
    await expect(page.getByText("Dev server")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop Dev server" }),
    ).toBeVisible();
    // Keep the stoppable job in frame under the open agent trail.
    await page.getByText("Dev server").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${dir}/live-agents-${theme}.png`,
    });
  });
}
