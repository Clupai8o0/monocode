import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`home lab chip and popover, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/tests/browser/lab-button.html?theme=${theme}`);
    const chip = page.locator("[data-fork-lab]");
    await expect(chip).toHaveText("All · Relay on");
    await expect(chip).toHaveAttribute("aria-label", /Remote Control on every machine, relay on/);
    await chip.screenshot({ path: `${dir}/lab-chip-${theme}.png` });

    await chip.click();
    const popover = page.getByRole("radiogroup", { name: "Remote Control scope" });
    await expect(popover).toBeVisible();
    await expect(page.getByRole("radio", { name: "Every machine" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Relay on vivobook" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: `${dir}/lab-popover-${theme}.png`,
      clip: { x: 1280 - 460, y: 720 - 560, width: 460, height: 560 },
    });

    // Remote desktop on: the address shows and the chip gets its dot.
    await page.getByRole("switch", { name: "Remote desktop" }).click();
    await expect(page.getByText("100.101.12.7:3389")).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", /Remote desktop is on for vivobook/);
    await page.screenshot({
      path: `${dir}/lab-popover-rdp-${theme}.png`,
      clip: { x: 1280 - 460, y: 720 - 560, width: 460, height: 560 },
    });

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(chip).toBeFocused();
    await chip.screenshot({ path: `${dir}/lab-chip-dot-${theme}.png` });

    // Narrow: the icon and the dot only.
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(chip.locator("span.tabular-nums")).toBeHidden();
  });
}
