import { expect, test, type Page } from "@playwright/test";

// GAME_SHOTS: a folder for the screenshots. GAME_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.GAME_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.GAME_BROWSER } });
}

const GAMES = ["blocks", "agent run", "mono bros", "pac-man", "snake"];

async function open(page: Page, theme = "dark") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/tests/browser/games-panel.html?theme=${theme}`);
  await page.locator("[data-fork-games]").click();
  await expect(page.getByRole("dialog", { name: "Games" })).toBeVisible();
}

const score = async (page: Page) =>
  Number(
    await page
      .locator("[data-fork-games-score]")
      .getAttribute("data-fork-games-score"),
  );

const board = (page: Page) => page.locator("[data-grid-board]");

/** Cells lit on the live canvas: the board's own proof it is drawing. */
const litPixels = (page: Page) =>
  page.evaluate(() => {
    let best = 0;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
      "[data-grid-board] canvas",
    )) {
      const rect = canvas.getBoundingClientRect();
      const host = document.querySelector("[data-grid-board]")!.getBoundingClientRect();
      if (Math.abs(rect.left - host.left) > 2) continue;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 40) lit += 1;
      best = Math.max(best, lit);
    }
    return best;
  });

test("each game draws in the panel, and the last one is remembered", async ({
  page,
}, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await open(page);
  await expect(page.getByRole("tab", { name: "blocks" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  for (const name of GAMES) {
    await page.getByRole("tab", { name }).click();
    await expect(board(page)).toBeFocused();
    await page.waitForTimeout(1500);
    expect(await litPixels(page), name).toBeGreaterThan(50);
    await page.screenshot({
      path: `${dir}/game-${name.replace(/\W+/g, "-")}.png`,
      clip: { x: 1280 - 640, y: 800 - 580, width: 640, height: 580 },
    });
  }
  await page.reload();
  await page.locator("[data-fork-games]").click();
  await expect(page.getByRole("tab", { name: "snake" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("blocks plays through the keyboard and retries on Space", async ({ page }) => {
  await open(page);
  await page.waitForTimeout(500);
  const before = await litPixels(page);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press(" ");
  await page.waitForTimeout(200);
  expect(await litPixels(page)).toBeGreaterThanOrEqual(before);
  // Stack straight up until it tops out.
  const status = page.getByRole("status");
  for (let i = 0; i < 40 && !(await status.count()); i++) {
    await page.keyboard.press(" ");
    await page.waitForTimeout(50);
  }
  await expect(status).toHaveText(/game over · space to retry/);
  await page.keyboard.press(" ");
  await expect(status).toHaveCount(0);
});

test("agent run jumps, scores and ends", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "agent run" }).click();
  await page.keyboard.press(" ");
  await expect.poll(() => score(page), { timeout: 8000 }).toBeGreaterThan(2);
  await expect(page.getByRole("status")).toHaveText(/game over/, {
    timeout: 30_000,
  });
});

test("mono bros runs on a held key", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "mono bros" }).click();
  await page.keyboard.down("ArrowRight");
  await expect.poll(() => score(page), { timeout: 8000 }).toBeGreaterThan(0);
  await page.keyboard.up("ArrowRight");
  await expect(page.getByLabel("3 lives")).toBeVisible();
});

test("typing in the composer pauses, a click resumes, Esc hides and keeps the game", async ({
  page,
}, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await open(page);
  await page.getByRole("tab", { name: "agent run" }).click();
  await page.waitForTimeout(1200);

  const composer = page.getByLabel("Composer", { exact: true });
  await composer.click();
  await page.keyboard.type("x j");
  await expect(composer).toHaveValue("x j");
  await expect(page.getByRole("status")).toHaveText(/paused/);
  const frozen = await score(page);
  await page.waitForTimeout(600);
  expect(await score(page)).toBe(frozen);

  await board(page).click();
  await expect(page.getByRole("status")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Games" })).toBeHidden();
  const parked = await score(page);
  await page.waitForTimeout(500);
  expect(await score(page)).toBe(parked);
  await page.locator("[data-fork-games]").click();
  await expect(page.getByRole("dialog", { name: "Games" })).toBeVisible();
  await expect(board(page)).toBeFocused();
  expect(await score(page)).toBeGreaterThanOrEqual(parked);
  await page.screenshot({
    path: `${dir}/game-resumed.png`,
    clip: { x: 640, y: 220, width: 640, height: 580 },
  });
});

test("agents finishing or waiting stop the game until a key", async ({ page }, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await open(page);
  const set = (working: number, waiting: number) =>
    page.evaluate(
      ([a, b]) =>
        (
          window as unknown as { __setAgents(a: number, b: number): void }
        ).__setAgents(a!, b!),
      [working, waiting],
    );
  await set(2, 0);
  await expect(page.getByText("2 agents working")).toBeVisible();
  await set(1, 1);
  await expect(page.getByRole("status")).toHaveText("An agent needs you");
  await expect(page.getByText("1 agent working · 1 needs you")).toBeVisible();
  await page.screenshot({
    path: `${dir}/game-notice.png`,
    clip: { x: 640, y: 220, width: 640, height: 580 },
  });
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("status")).toHaveCount(0);
  await set(0, 0);
  await expect(page.getByRole("status")).toHaveText("Agents finished");
  await board(page).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});
