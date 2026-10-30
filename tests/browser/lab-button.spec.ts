import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`home lab chip and popover, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    // Switches settle at once, so a shot never catches one halfway.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/tests/browser/lab-button.html?theme=${theme}`);
    const chip = page.locator("[data-fork-lab]");
    await expect(chip).toHaveText("Vivobook · 4 running");
    await expect(chip).toHaveAttribute("aria-label", /Remote Control on every machine, relay on/);
    await chip.screenshot({ path: `${dir}/lab-chip-${theme}.png` });

    await chip.click();
    const popover = page.getByRole("radiogroup", { name: "Remote Control scope" });
    await expect(popover).toBeVisible();
    await expect(page.locator("[data-fork-lab-running]")).toHaveText("Vivobook · 4 sessions running");
    await expect(page.getByRole("button", { name: "New session on Vivobook" })).toBeEnabled();
    await expect(page.getByRole("radio", { name: "Every machine" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Relay on vivobook" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();
    const panel = page.locator('[aria-label="Home lab"]').last();
    const shoot = async (name: string) => {
      const box = (await panel.boundingBox())!;
      const top = Math.max(0, box.y - 24);
      await page.screenshot({ path: `${dir}/${name}-${theme}.png`, clip: { x: 1280 - 460, y: top, width: 460, height: 800 - top } });
    };
    await expect(page.getByText("Agents' time")).toBeVisible();
    await expect(page.getByRole("button", { name: /Follow this Mac \(Kolkata\)/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("vivobook uses Kolkata")).toBeVisible();
    await shoot("lab-popover");

    // The zone search: Escape closes it and leaves the popover open.
    await page.getByRole("button", { name: "Pick a zone" }).click();
    await page.getByRole("combobox", { name: "Find a time zone" }).fill("lond");
    await expect(page.getByRole("option").first()).toContainText("London");
    await shoot("lab-popover-tz");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(popover).toBeVisible();
    await expect(page.getByRole("button", { name: "Pick a zone" })).toBeFocused();

    // Escape still closes it when focus has moved elsewhere in the popover.
    await page.getByRole("button", { name: "Pick a zone" }).click();
    await page.getByRole("switch", { name: "Remote desktop" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(popover).toBeVisible();

    // Picking one: the Mac switches; the host waits for the watcher.
    await page.getByRole("button", { name: "Pick a zone" }).click();
    await page.getByRole("combobox", { name: "Find a time zone" }).fill("london");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "London" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "London" })).toBeFocused();
    await expect(page.getByText("vivobook: switching to London…")).toBeVisible();
    await shoot("lab-popover-tz-picked");
    await page.getByRole("button", { name: /Follow this Mac/ }).click();
    await expect(page.getByRole("button", { name: /Follow this Mac/ })).toHaveAttribute("aria-pressed", "true");

    // Remote desktop on: the address shows and the chip gets its dot.
    await page.getByRole("switch", { name: "Remote desktop" }).click();
    await expect(page.getByText("100.101.12.7:3389")).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", /Remote desktop is on for vivobook/);
    await expect(page.getByRole("switch", { name: "Remote desktop" })).toHaveAttribute("aria-checked", "true");
    await shoot("lab-popover-rdp");

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(chip).toBeFocused();
    await chip.screenshot({ path: `${dir}/lab-chip-dot-${theme}.png` });

    // Narrow: the icon and the dot only.
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(chip.locator("span.tabular-nums")).toBeHidden();
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`home lab settings page, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 1400 });
    await page.goto(`/tests/browser/lab-button.html?view=settings&theme=${theme}`);
    // The agents' zone comes first and does not wait for a lab host.
    await expect(page.getByRole("heading", { name: "Agents' time zone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "vivobook" })).toBeVisible();
    await expect(page.getByText("vivobook uses Kolkata")).toBeVisible();
    await page.screenshot({ path: `${dir}/lab-settings-${theme}.png`, fullPage: true });
  });
}
