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
const pauseChip = (page: Page) => page.locator("[data-fork-games-pause]");
const panel = (page: Page) => page.getByRole("dialog", { name: "Games" });
const fullscreenChip = (page: Page) =>
  page.locator("[data-fork-games-fullscreen]");
const grip = (page: Page) => page.locator("[data-fork-games-resize]");

const canvasSize = (page: Page) =>
  board(page)
    .locator("canvas")
    .first()
    .evaluate((canvas) => {
      const { width, height } = canvas as HTMLCanvasElement;
      return { width, height };
    });

/** Drags the grip by a screen delta, staying inside the viewport. */
async function dragGrip(page: Page, dx: number, dy: number) {
  const box = (await grip(page).boundingBox())!;
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(1, Math.min(1279, fromX + dx)),
    Math.max(1, Math.min(799, fromY + dy)),
    { steps: 8 },
  );
  await page.mouse.up();
}

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

test("Pause parks the board, and Resume, P or New game brings it back", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "agent run" }).click();
  await expect(board(page)).toBeFocused();

  await pauseChip(page).click();
  await expect(pauseChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText(
    "paused · P or click to resume",
  );
  const held = await score(page);
  await page.waitForTimeout(600);
  expect(await score(page)).toBe(held);

  // The chip resumes, and gives the keyboard back to the board.
  await pauseChip(page).click();
  await expect(pauseChip(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(board(page)).toBeFocused();

  // P toggles from the board, and keeps its own key to itself.
  await page.keyboard.press("p");
  await expect(page.getByRole("status")).toHaveText(
    "paused · P or click to resume",
  );
  await page.keyboard.press("p");
  await expect(page.getByRole("status")).toHaveCount(0);

  // A new game clears a pause, as picking a game does.
  await page.keyboard.press("p");
  await expect(page.getByRole("status")).toHaveText(/paused/);
  await page.getByRole("button", { name: "New game" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(pauseChip(page)).toHaveAttribute("aria-pressed", "false");
});

test("the Pause chip is gone once a grid game is over", async ({ page }) => {
  await open(page);
  const status = page.getByRole("status");
  for (let i = 0; i < 40 && !(await status.count()); i++) {
    await page.keyboard.press(" ");
    await page.waitForTimeout(50);
  }
  await expect(status).toHaveText(/game over/);
  await expect(pauseChip(page)).toHaveCount(0);
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
  // Unseeded level: the run may already have met a pit.
  await expect(page.getByLabel(/[123] lives/)).toBeVisible();
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

test("Full screen fills the window above the footer, and back", async ({ page }) => {
  await open(page);
  await fullscreenChip(page).click();
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(fullscreenChip(page)).toHaveText("Exit full screen");

  const full = (await panel(page).boundingBox())!;
  expect(full.x).toBe(10);
  expect(full.y).toBe(10);
  expect(full.width).toBe(1260);
  expect(full.height).toBe(756);
  // The footer keeps its room, and the resize chrome steps out of the way.
  const footer = (await page.locator("footer").boundingBox())!;
  expect(footer.y).toBeGreaterThanOrEqual(full.y + full.height);
  await expect(grip(page)).toHaveCount(0);

  await fullscreenChip(page).click();
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "false");
  await expect(fullscreenChip(page)).toHaveText("Full screen");
  const back = (await panel(page).boundingBox())!;
  expect(back.width).toBe(600);
  expect(back.height).toBe(548);
});

test("F toggles full screen on a grid game, and Esc still hides", async ({ page }) => {
  await open(page);
  await expect(board(page)).toBeFocused();
  await page.keyboard.press("f");
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "true");
  expect((await panel(page).boundingBox())!.width).toBe(1260);
  await page.keyboard.press("f");
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("f");
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();

  // The choice is kept, so reopening comes back full screen.
  await page.reload();
  await page.locator("[data-fork-games]").click();
  await expect(fullscreenChip(page)).toHaveAttribute("aria-pressed", "true");
  expect((await panel(page).boundingBox())!.width).toBe(1260);
});

test("dragging the grip grows the panel and the board, without resuming", async ({
  page,
}) => {
  await open(page);
  await expect(board(page)).toBeFocused();
  await page.keyboard.press("p");
  await expect(page.getByRole("status")).toHaveText(
    "paused · P or click to resume",
  );
  await expect.poll(async () => (await canvasSize(page)).width).toBeGreaterThan(0);
  const before = (await panel(page).boundingBox())!;
  const canvas = await canvasSize(page);

  await dragGrip(page, -100, -60);

  const after = (await panel(page).boundingBox())!;
  expect(after.width).toBe(before.width + 100);
  expect(after.height).toBe(before.height + 60);
  await expect(page.getByRole("status")).toHaveText(
    "paused · P or click to resume",
  );
  await expect
    .poll(async () => (await canvasSize(page)).width)
    .toBeGreaterThan(canvas.width);
  await expect
    .poll(async () => (await canvasSize(page)).height)
    .toBeGreaterThan(canvas.height);
});

test("a dragged size is kept after hiding, reopening and reloading", async ({
  page,
}) => {
  await open(page);
  await dragGrip(page, -80, -40);
  const grown = (await panel(page).boundingBox())!;
  expect(grown.width).toBe(680);
  expect(grown.height).toBe(588);

  await page.getByRole("button", { name: "Hide" }).click();
  await expect(panel(page)).toBeHidden();
  await page.locator("[data-fork-games]").click();
  await expect(panel(page)).toBeVisible();
  const reopened = (await panel(page).boundingBox())!;
  expect(reopened.width).toBe(680);
  expect(reopened.height).toBe(588);

  await page.reload();
  await page.locator("[data-fork-games]").click();
  await expect(panel(page)).toBeVisible();
  const reloaded = (await panel(page).boundingBox())!;
  expect(reloaded.width).toBe(680);
  expect(reloaded.height).toBe(588);
});

test("the panel stops at its minimum size", async ({ page }) => {
  await open(page);
  const before = (await panel(page).boundingBox())!;
  await dragGrip(page, 900, 900);
  const after = (await panel(page).boundingBox())!;
  expect(after.width).toBe(420);
  expect(after.height).toBe(360);
  // Anchored bottom-right, so it grew towards the window's corner.
  expect(after.x - before.x).toBe(before.width - 420);
  expect(after.y - before.y).toBe(before.height - 360);
});

test("double-clicking the grip resets the grid default", async ({ page }) => {
  await open(page);
  await dragGrip(page, -100, -60);
  expect((await panel(page).boundingBox())!.width).toBe(700);
  await grip(page).dblclick();
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(600);
  expect((await panel(page).boundingBox())!.height).toBe(548);
});

test("a smaller window takes the room back", async ({ page }) => {
  await open(page);
  await dragGrip(page, -100, -60);
  expect((await panel(page).boundingBox())!.width).toBe(700);

  await page.setViewportSize({ width: 640, height: 500 });
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(640 - 20);
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBe(10);
  expect(box.y).toBe(10);
  expect(box.y + box.height).toBe(500 - 34);
});

test("grid and table sizes are kept apart", async ({ page }) => {
  await open(page);
  await dragGrip(page, -80, -40);
  expect((await panel(page).boundingBox())!.width).toBe(680);

  await page.getByRole("tab", { name: "poker" }).click();
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(720);
  expect((await panel(page).boundingBox())!.height).toBe(560);

  await page.getByRole("tab", { name: "blocks" }).click();
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(680);
  expect((await panel(page).boundingBox())!.height).toBe(588);
});
