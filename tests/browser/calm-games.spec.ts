import { expect, test, type Page } from "@playwright/test";

// LAB_BROWSER: a Chromium to run when the one Playwright expects is not
// downloaded; LAB_SHOTS: a folder for the screenshots.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

async function open(page: Page, game: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto(`/tests/browser/calm-games.html?game=${game}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/tests/browser/calm-games.html?game=${game}`);
  await expect(page.getByRole("dialog", { name: "Games" })).toBeVisible();
  return errors;
}

async function shot(page: Page, name: string, outputDir: string) {
  const dir = process.env.LAB_SHOTS ?? outputDir;
  await page.screenshot({ path: `${dir}/calm-${name}.png` });
}

test("agent garden plants, waters and keeps the beds", async ({ page }, testInfo) => {
  const errors = await open(page, "garden");
  const bed = page.locator("[data-bed='0']");
  await expect(bed).toHaveAttribute("data-bed-state", "empty");
  await bed.click();
  await expect(bed).toHaveAttribute("data-bed-state", "growing");
  await bed.click();
  await expect(bed).toHaveAttribute("data-bed-state", "watered");
  await shot(page, "garden", testInfo.outputDir);
  await page.reload();
  await expect(page.locator("[data-bed='0']")).toHaveAttribute("data-bed-state", "watered");
  expect(errors).toEqual([]);
});

test("solitaire deals, draws and counts moves", async ({ page }, testInfo) => {
  const errors = await open(page, "solitaire");
  const stock = page.locator("[data-sol='stock']");
  await expect(stock).toBeVisible();
  const moves = page.locator("[data-sol-moves]");
  const before = Number(await moves.getAttribute("data-sol-moves"));
  await stock.click();
  await expect(moves).not.toHaveAttribute("data-sol-moves", String(before));
  await shot(page, "solitaire", testInfo.outputDir);
  expect(errors).toEqual([]);
});

test("colour sort picks up a tube and pours", async ({ page }, testInfo) => {
  const errors = await open(page, "sort");
  const tubes = page.locator("[data-tube]");
  await expect(tubes.first()).toBeVisible();
  const count = await tubes.count();
  expect(count).toBeGreaterThanOrEqual(6);
  // The last tubes start empty, so pouring the first into one always works.
  const empty = tubes.nth(count - 1);
  await expect(empty).toHaveAttribute("aria-label", /empty/);
  await tubes.first().click();
  await empty.click();
  await expect(empty).not.toHaveAttribute("aria-label", /empty/);
  await shot(page, "sort", testInfo.outputDir);
  expect(errors).toEqual([]);
});

for (const game of ["stack", "sand"]) {
  test(`${game} plays on the grid`, async ({ page }, testInfo) => {
    const errors = await open(page, game);
    const dialog = page.getByRole("dialog", { name: "Games" });
    await dialog.locator("[data-grid-board]").focus();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Space");
      await page.waitForTimeout(250);
    }
    const score = dialog.locator("[data-fork-games-score]");
    await expect(score).not.toHaveAttribute("data-fork-games-score", "0");
    await shot(page, game, testInfo.outputDir);
    expect(errors).toEqual([]);
  });
}
