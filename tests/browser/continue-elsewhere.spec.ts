import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`continue elsewhere, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 820, height: 320 });
    await page.goto(`/tests/browser/continue-elsewhere.html?theme=${theme}`);
    await expect(
      page.getByRole("button", { name: "Continue in Codex" }),
    ).toBeVisible();
    await expect(page.getByText("Continued from Claude")).toBeVisible();
    await page.screenshot({ path: `${dir}/limit-and-card-${theme}.png` });
  });
}
