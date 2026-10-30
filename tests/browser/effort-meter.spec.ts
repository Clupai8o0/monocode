import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const meter = '[data-effort-meter]';
const filled = `${meter} .effort-meter-fill[data-on]`;

test("the model raises and lowers effort, and the meter follows", async ({ page }) => {
  await page.goto("/tests/browser/effort-meter.html");
  await expect(page.locator(meter)).toHaveAttribute("data-level", "high");
  await expect(page.locator(filled)).toHaveCount(3);

  await page.evaluate(() => window.startTurn());
  await expect(page.locator(meter)).toHaveAttribute("data-busy", "");
  expect(
    await page.locator(filled).first().evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("effort-meter-shimmer");

  await page.evaluate(() => window.endTurn("xhigh"));
  await expect(page.locator(meter)).toHaveAttribute("data-level", "xhigh");
  await expect(page.locator(filled)).toHaveCount(4);
  await expect(page.getByRole("status")).toHaveText("↑ xhigh");
  await expect(page.locator("[data-notes]")).toContainText(
    "Effort raised to xhigh (model asked)",
  );

  await page.evaluate(() => window.startTurn());
  await page.evaluate(() => window.endTurn("low"));
  await expect(page.locator(filled)).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("↓ low");
  await expect(page.locator("[data-notes]")).toContainText(
    "Effort lowered to low (model asked)",
  );
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 4000 });
});

test("an ask for the current effort leaves everything alone", async ({ page }) => {
  await page.goto("/tests/browser/effort-meter.html");
  await page.evaluate(() => window.startTurn());
  await page.evaluate(() => window.endTurn("high"));
  await expect(page.locator(meter)).not.toHaveAttribute("data-busy", "");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("[data-notes] li")).toHaveCount(0);
});

test("clicking the meter opens the picker", async ({ page }) => {
  await page.goto("/tests/browser/effort-meter.html");
  await page.locator(meter).click();
  expect(await page.evaluate(() => window.pickerClicks)).toBe(1);
});

test("reduced motion keeps colors and stops movement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/effort-meter.html");
  await page.evaluate(() => window.startTurn());
  const style = await page.locator(filled).first().evaluate((el) => {
    const css = getComputedStyle(el);
    return { animation: css.animationName, transition: css.transitionDuration };
  });
  expect(style.animation).toBe("none");
  expect(style.transition).toBe("0s");
});

test("ultracode glows", async ({ page }) => {
  await page.goto("/tests/browser/effort-meter.html?ultracode");
  await expect(page.locator(meter)).toHaveAttribute("data-ultracode", "");
  expect(
    await page.locator(filled).first().evaluate((el) => getComputedStyle(el).boxShadow),
  ).not.toBe("none");
});

for (const theme of ["dark", "light"] as const) {
  test(`every level, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 120 });
    await page.goto(`/tests/browser/effort-meter.html?theme=${theme}`);
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      await page.evaluate(() => window.startTurn());
      await page.evaluate((needed) => window.endTurn(needed), level);
      await expect(page.locator(meter)).toHaveAttribute("data-level", level);
      await page.screenshot({ path: `${dir}/effort-${theme}-${level}.png` });
    }
  });
}
