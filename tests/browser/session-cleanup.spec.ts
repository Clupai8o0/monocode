import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`session cleanup across projects, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(`/tests/browser/session-cleanup.html?theme=${theme}`);

    const dialog = page.getByRole("dialog", { name: "Clean up sessions" });
    await expect(dialog.getByRole("button", { name: "Archive 4" })).toBeVisible();
    await expect(dialog.getByText("4 selected in 3 projects")).toBeVisible();
    await page.screenshot({ path: `${dir}/safe-${theme}.png` });

    await dialog.getByRole("button", { name: /^Everything/ }).click();
    await expect(dialog.getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
    await expect(dialog.getByText("Nothing selected")).toBeVisible();
    await page.screenshot({ path: `${dir}/everything-${theme}.png` });

    await dialog.getByRole("button", { name: /^Safe to close/ }).click();
    await dialog.getByRole("button", { name: "Archive 4" }).click();
    await expect(dialog.getByText("Archived 4.")).toBeVisible();
    await page.screenshot({ path: `${dir}/archived-${theme}.png` });

    await dialog.getByRole("button", { name: "Undo" }).click();
    await expect(dialog.getByText("Restored 4.")).toBeVisible();
    const calls = await page.evaluate(
      () => (window as unknown as { __archiveCalls: unknown[] }).__archiveCalls,
    );
    expect(calls).toHaveLength(8);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("[data-closed]")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
