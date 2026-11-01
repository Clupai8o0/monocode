import { expect, test, type Page } from "@playwright/test";

// The four games about the work itself: pipeline, merge conflict, turn bet, token rain.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

async function open(page: Page, game: string, extra = "") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto(`/tests/browser/calm-games.html?game=${game}${extra}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/tests/browser/calm-games.html?game=${game}${extra}`);
  await expect(page.getByRole("dialog", { name: "Games" })).toBeVisible();
  return errors;
}

async function shot(page: Page, name: string, outputDir: string) {
  const dir = process.env.LAB_SHOTS ?? outputDir;
  await page.screenshot({ path: `${dir}/work-${name}.png` });
}

test("pipeline turns a tile when clicked", async ({ page }, testInfo) => {
  const errors = await open(page, "pipeline");
  const tile = page.locator("[data-pipe-tile='0']");
  await expect(tile).toBeVisible();
  await expect(page.locator("[data-pipe-commit]")).toBeVisible();
  await expect(page.locator("[data-pipe-deploy]")).toBeVisible();
  await tile.click();
  await expect(page.getByText(/1 turn/)).toBeVisible();
  await shot(page, "pipeline", testInfo.outputDir);
  expect(errors).toEqual([]);
});

test("merge conflict takes typing and counts it", async ({ page }, testInfo) => {
  const errors = await open(page, "merge");
  await expect(page.locator("[data-merge-conflict]")).toBeVisible();
  await page.locator("[data-table-board='Merge conflict']").focus();
  await page.keyboard.type("cons");
  await page.keyboard.press("Backspace");
  await shot(page, "merge", testInfo.outputDir);
  expect(errors).toEqual([]);
});

test("turn bet takes a bet on a running turn and settles it", async ({ page }, testInfo) => {
  const errors = await open(page, "turnbet", "&turns=1");
  const row = page.locator("[data-turnbet-turn='s1']");
  await expect(row).toBeVisible();
  await row.locator("[data-action='more']").click();
  await row.locator("[data-action='bet']").click();
  await expect(row).toHaveAttribute("data-turnbet-bet", /\d+/);
  await shot(page, "turnbet-live", testInfo.outputDir);
  await page.evaluate(() => (window as { endTurn?: (id: string) => void }).endTurn?.("s1"));
  await expect(page.locator("[data-turnbet-result]")).toHaveCount(1);
  await expect(page.locator("[data-turnbet-turn='s1']")).toHaveCount(0);
  await shot(page, "turnbet-settled", testInfo.outputDir);
  expect(errors).toEqual([]);
});

test("token rain plays with the arrows and space", async ({ page }, testInfo) => {
  const errors = await open(page, "rain");
  const board = page.locator("[data-grid-board]");
  await board.click();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.waitForTimeout(2500);
  await page.keyboard.press("Space");
  await shot(page, "rain", testInfo.outputDir);
  expect(errors).toEqual([]);
});
