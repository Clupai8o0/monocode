import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`mono dashboard, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto(`/tests/browser/mono-dashboard.html?theme=${theme}`);
    const panel = page.locator('[data-shot="dashboard"]');
    await expect(panel.getByText("in the last 6 months")).toBeVisible();
    await expect(panel.getByText(/-day streak/)).toBeVisible();
    await expect(
      panel.getByText("Working on Fix the login redirect"),
    ).toBeVisible();
    await expect(panel.getByText("Morning digest")).toBeVisible();
    await expect(panel.getByText("Release notes")).toBeVisible();
    await expect(panel.getByText("Old notes")).toHaveCount(0);
    await panel.screenshot({ path: `${dir}/wide-${theme}.png` });

    // Hovering a square names its day.
    const calendar = panel.getByRole("img", { name: /Contribution calendar/ });
    const box = (await calendar.boundingBox())!;
    // This week's Sunday: always inside the fixture's run of active days.
    await page.mouse.move(box.x + 28 + 25 * 10 + 4, box.y + 18 + 4);
    await expect(panel.getByRole("status")).toContainText("Lines");
    await panel.screenshot({ path: `${dir}/hover-${theme}.png` });
    await page.mouse.move(0, 0);

    // A narrow panel keeps the latest weeks instead of overflowing.
    await page.goto(
      `/tests/browser/mono-dashboard.html?theme=${theme}&width=240`,
    );
    const narrow = page.locator('[data-shot="dashboard"]');
    await expect(narrow.getByText("in the last 6 months")).toBeVisible();
    const overflow = await narrow.evaluate(
      (node) => node.scrollWidth - node.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await narrow.screenshot({ path: `${dir}/narrow-${theme}.png` });

    // A new Mono has nothing yet, and says so.
    await page.goto(`/tests/browser/mono-dashboard.html?theme=${theme}&empty`);
    const fresh = page.locator('[data-shot="dashboard"]');
    await expect(
      fresh.getByText("Nothing scheduled.", { exact: false }),
    ).toBeVisible();
    await expect(fresh.getByText("Nothing new yet today.")).toBeVisible();
    await fresh.screenshot({ path: `${dir}/empty-${theme}.png` });
  });
}
