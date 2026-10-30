import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const SHOTS = [
  "setting",
  "note",
  "coach",
  "panel-fast-forward",
  "panel-merge",
  "panel-uncommitted",
  "panel-conflict",
  "panel-merged",
];

for (const theme of ["dark", "light"] as const) {
  test(`worktree strip, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 760, height: 1400 });
    await page.goto(`/tests/browser/worktree-strip.html?theme=${theme}`);

    for (const id of SHOTS) {
      await page
        .locator(`[data-shot="${id}"]`)
        .screenshot({ path: `${dir}/${id}-${theme}.png` });
    }

    // The setting's three choices, smart first.
    const smart = page.getByRole("radio", { name: /^Smart/ });
    await expect(smart).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: /^Never/ }).click();
    await expect(page.getByRole("radio", { name: /^Never/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await smart.click();

    // Merge back from the live strip, through to offering removal.
    const live = page.locator('[data-shot="live"]');
    await expect(live.getByText("+142")).toBeVisible();
    await live.getByRole("button", { name: "Merge back" }).click();
    await live.screenshot({ path: `${dir}/strip-open-${theme}.png` });
    await live.getByRole("button", { name: "Merge into mine" }).click();
    await expect(live.getByText("Merged into mine")).toBeVisible();
    await expect(
      live.getByRole("button", { name: "Remove worktree" }),
    ).toBeVisible();
    await live.screenshot({ path: `${dir}/strip-merged-${theme}.png` });
  });
}
