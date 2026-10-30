import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`device panel, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1060, height: 860 });
    await page.goto(`/tests/browser/device-panel.html?theme=${theme}`);
    await page.screenshot({ path: `${dir}/panels-${theme}.png` });

    const panel = page.locator('[data-shot="ios"]');
    const events = panel.locator("[data-events]");
    const screen = panel.getByRole("img", { name: "iPhone 17 Pro screen" });
    await expect(screen).toBeVisible();
    const box = (await screen.boundingBox())!;

    // A click in the middle lands in the middle of the device's own pixels.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(events).toHaveText("tap 540 1170");

    // A drag is a swipe, not a tap.
    await page.mouse.move(box.x + 40, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.up();
    await expect(events).toHaveText("tap 540 1170, swipe");

    await panel.getByLabel("Type on the device").fill("hello");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(events).toHaveText("tap 540 1170, swipe, type hello");
  });
}
