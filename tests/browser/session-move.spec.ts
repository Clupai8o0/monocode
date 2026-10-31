import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`session move, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 820, height: 620 });
    await page.goto(`/tests/browser/session-move.html?theme=${theme}`);

    // The progress line, Cancel only while it can still be cancelled.
    await expect(page.getByText("Moves when this turn ends")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(1);
    await expect(page.getByText("Carrying the code and conversation to Vivobook, 42%")).toBeVisible();
    await expect(page.getByText("Vivobook is full, so it is waiting in line")).toBeVisible();
    await expect(page.getByText("Did not move. This repository is not on that machine")).toBeVisible();

    // The card.
    await expect(page.getByText(/^Moved to Vivobook at 10.42/)).toBeVisible();
    await expect(page.getByText("Left behind: .env, node_modules/, and 2 more")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open live session" })).toHaveCount(2);

    // The menu item, disabled with its reason.
    await expect(page.getByText("Vivobook is offline")).toBeVisible();
    await expect(page.getByText("Update Vivobook to move sessions")).toBeVisible();
    await expect(page.getByText("It is waiting for your answer")).toBeVisible();

    // No divider lines anywhere in the card or the line.
    const rules = await page
      .locator("[data-fork-moved-card], [data-fork-move-line]")
      .evaluateAll((nodes) =>
        nodes.filter((node) => {
          const style = getComputedStyle(node);
          return parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
        }).length,
      );
    expect(rules).toBe(0);

    await page.screenshot({ path: `${dir}/session-move-${theme}.png` });
  });
}
