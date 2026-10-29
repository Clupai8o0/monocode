import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`messages window feed and map, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1180, height: 860 });
    await page.goto(`/tests/browser/messages-window.html?theme=${theme}`);
    const dialog = page.getByRole("dialog", { name: "Messages" });
    await expect(dialog).toBeVisible();
    await expect(page.locator("[data-feed-row]")).toHaveCount(8);
    await expect(page.getByRole("status")).toContainText("The relay is off on Vivobook");
    await page.screenshot({ path: `${dir}/messages-feed-${theme}.png` });

    // A dropped message between machines, opened.
    await page.locator('[data-feed-row="r4"] button[aria-expanded]').click();
    await expect(page.getByText("Relay trail")).toBeVisible();
    await page.screenshot({ path: `${dir}/messages-feed-open-${theme}.png` });
    await page.getByRole("button", { name: "Open lab-runner" }).click();
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toContain("open:mono-9");

    await page.getByRole("button", { name: "Problems only" }).click();
    await expect(page.locator("[data-feed-row]")).toHaveCount(2);
    await page.screenshot({ path: `${dir}/messages-problems-${theme}.png` });
    await page.getByRole("button", { name: "Problems only" }).click();

    await page.getByRole("tab", { name: "Map" }).click();
    await expect(page.locator("[data-map-place]")).toHaveCount(3);
    await page.screenshot({ path: `${dir}/messages-map-${theme}.png` });

    // A session on the map filters the feed to it.
    await page.locator('[data-map-node="m1:d4e5f6a7"]').click();
    await expect(page.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-feed-row]")).toHaveCount(3);
    await expect(page.getByText("Only lab-runner")).toBeVisible();
    await page.screenshot({ path: `${dir}/messages-party-${theme}.png` });

    await page.getByRole("button", { name: "Open Home lab" }).click();
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toContain("lab");
  });
}
