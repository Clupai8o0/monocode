import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`feature coach, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 1400 });
    await page.goto(`/tests/browser/feature-coach.html?theme=${theme}`);
    const shot = page.locator('[data-shot="page"]');
    await expect(shot.getByRole("heading", { name: "Worktrees" })).toBeVisible();
    await shot.screenshot({ path: `${dir}/tips-${theme}.png` });
    await page
      .locator('[data-shot="mark"]')
      .screenshot({ path: `${dir}/followup-mark-${theme}.png` });

    // Presets are offered, and nothing is added until it is pressed.
    const add = shot.getByRole("button", { name: "Add to Sweep" });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(shot.getByRole("button", { name: "Added" })).toBeDisabled();
  });
}
