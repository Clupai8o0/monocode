import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`cost panel, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 760, height: 560 });
    await page.goto(`/tests/browser/cost-panel.html?theme=${theme}`);
    const panel = page.locator('[data-shot="cost"]');
    await expect(panel.getByText("Saved by cache")).toBeVisible();
    await expect(panel.getByRole("cell", { name: "Opus 5.5" })).toBeVisible();
    await panel.screenshot({ path: `${dir}/daily-${theme}.png` });

    await panel.getByRole("img").hover({ position: { x: 280, y: 60 } });
    await expect(panel.getByRole("status")).toContainText("Total");
    await panel.screenshot({ path: `${dir}/hover-${theme}.png` });

    await panel.getByRole("tab", { name: "Weekly" }).click();
    await expect(panel.getByRole("tab", { name: "Weekly" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.mouse.move(0, 0);
    await panel.screenshot({ path: `${dir}/weekly-${theme}.png` });
  });
}
