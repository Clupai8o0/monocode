import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`turn diff and restore, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`/tests/browser/turn-diff.html?theme=${theme}`);
    const turn = page.locator('[data-shot="turn"]');
    await turn.screenshot({ path: `${dir}/chip-${theme}.png` });
    await page
      .locator('[data-shot="blocked"]')
      .screenshot({ path: `${dir}/restore-blocked-${theme}.png` });

    await turn.getByRole("button", { name: /Show this turn/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Collapse src/auth/redirect.ts" }),
    ).toBeVisible();
    await expect(dialog.getByText("safeRedirect").first()).toBeVisible();
    await page.screenshot({ path: `${dir}/turn-diff-${theme}.png` });

    // Restore asks first, and lists every file it would touch.
    await dialog.getByRole("button", { name: "Restore to before this turn" }).click();
    const confirm = dialog.locator("[data-fork-restore-confirm]");
    await expect(confirm.getByText("Put 3 files back")).toBeVisible();
    await expect(confirm.getByText("tests/login.test.ts")).toBeVisible();
    await expect(confirm.getByText(/changed since/)).toBeVisible();
    await page.screenshot({ path: `${dir}/restore-confirm-${theme}.png` });
    await confirm.getByRole("button", { name: "Restore 3 files" }).click();
    await expect(confirm.getByText(/^Restored\./)).toBeVisible();
  });
}
