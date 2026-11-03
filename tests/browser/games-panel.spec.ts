import { expect, test, type Page } from "@playwright/test";

// GAME_SHOTS: a folder for the screenshots. GAME_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.GAME_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.GAME_BROWSER } });
}

// The panel's open animation would otherwise be caught in every measurement.
test.use({ contextOptions: { reducedMotion: "reduce" } });

const GAMES = ["blocks", "agent run", "mono bros", "pac-man", "snake"];

async function pickGame(page: Page, name: string) {
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

const gameSelect = (page: Page) => page.getByRole("button", { name: "Game", exact: true });

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
  await expect(gameSelect(page)).toHaveText("blocks");
  for (const name of GAMES) {
    await pickGame(page, name);
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
  await expect(gameSelect(page)).toHaveText("snake");
});

test("Pause parks the board, and Resume, P or New game brings it back", async ({ page }) => {
  await open(page);
  await pickGame(page, "agent run");
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
  await pickGame(page, "agent run");
  await page.keyboard.press(" ");
  await expect.poll(() => score(page), { timeout: 8000 }).toBeGreaterThan(2);
  await expect(page.getByRole("status")).toHaveText(/game over/, {
    timeout: 30_000,
  });
});

test("mono bros runs on a held key", async ({ page }) => {
  await open(page);
  await pickGame(page, "mono bros");
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
  await pickGame(page, "agent run");
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
  await expect(fullscreenChip(page)).toHaveAttribute("aria-label", "Exit full screen");

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
  await expect(fullscreenChip(page)).toHaveAttribute("aria-label", "Full screen");
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
  // The whole toolbar still fits at the smallest size, down to Hide.
  const code = (await panel(page).getByRole("button", { name: "Hide" }).boundingBox())!;
  expect(code.x + code.width).toBeLessThanOrEqual(after.x + after.width);
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

  await pickGame(page, "poker");
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(720);
  expect((await panel(page).boundingBox())!.height).toBe(560);

  await pickGame(page, "blocks");
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(680);
  expect((await panel(page).boundingBox())!.height).toBe(588);
});

test("Side by side puts the app on the left and the games on the right", async ({
  page,
}) => {
  await open(page);
  const dock = page.locator("[data-fork-games-dock]");
  const appRoot = page.locator("#root");
  const before = (await appRoot.boundingBox())!;

  await dock.click();
  await expect(dock).toHaveAttribute("aria-pressed", "true");
  await expect(fullscreenChip(page)).toHaveCount(0);
  const side = (await panel(page).boundingBox())!;
  const app = (await appRoot.boundingBox())!;
  // Full height on the right, and the app ends just left of it.
  expect(side.y).toBe(10);
  expect(side.x + side.width).toBe(before.width - 10);
  expect(app.width).toBe(side.x - 10);
  const footer = (await page.locator("footer").boundingBox())!;
  expect(footer.x + footer.width).toBeLessThanOrEqual(side.x);

  // F does nothing side by side; the left edge still resizes.
  await page.keyboard.press("f");
  await expect(dock).toHaveAttribute("aria-pressed", "true");
  const edge = (await page.locator('[data-fork-games-resize-edge="left"]').boundingBox())!;
  await page.mouse.move(edge.x + 2, edge.y + 100);
  await page.mouse.down();
  await page.mouse.move(edge.x - 98, edge.y + 100, { steps: 4 });
  await page.mouse.up();
  const wider = (await panel(page).boundingBox())!;
  expect(wider.width).toBe(side.width + 100);
  expect((await appRoot.boundingBox())!.width).toBe(app.width - 100);

  // Hiding gives the app its whole width back.
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(panel(page)).toBeHidden();
  expect((await appRoot.boundingBox())!.width).toBe(before.width);
});

test("the game picker fits a short window and finds a game by typing", async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 900, height: 420 });
  await gameSelect(page).click();
  const search = page.getByRole("combobox", { name: "Find a game" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveCount(20);
  const list = (await page.getByRole("listbox", { name: "Game" }).boundingBox())!;
  expect(list.y + list.height).toBeLessThanOrEqual(420);
  expect(list.y).toBeGreaterThanOrEqual(0);
  // The last row is one scroll away, not off the window.
  await page.getByRole("option", { name: "pipeline", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("option", { name: "pipeline", exact: true })).toBeInViewport();

  await search.fill("sud");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Game" })).toHaveCount(0);
  await expect(gameSelect(page)).toHaveText("sudoku");
  await expect(page.locator("[data-table-active] [data-table-board]")).toBeFocused();

  // Nothing found says so, and Enter there does nothing.
  await gameSelect(page).click();
  await search.fill("zzz");
  await expect(page.getByText("No game matches that.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(gameSelect(page)).toHaveText("sudoku");
});

test("arrow keys walk the picker, and a group name finds its games", async ({ page }) => {
  await open(page);
  await gameSelect(page).click();
  const search = page.getByRole("combobox", { name: "Find a game" });
  await search.fill("puzzles");
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  // garden, colour sort, garden: then Enter takes the row that's lit.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(gameSelect(page)).toHaveText("sudoku");
});

test("Esc on a dropdown closes the dropdown and leaves the game open", async ({ page }) => {
  await open(page);
  await expect(board(page)).toBeFocused();

  // The picker has the keyboard while it's up, and gives it back.
  await gameSelect(page).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Game" })).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(board(page)).toBeFocused();

  // Difficulty leaves the keyboard on the board, and Esc still isn't the board's.
  await page.getByRole("button", { name: "Difficulty", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Difficulty" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Difficulty" })).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // With no dropdown up, Esc hides the panel as ever.
  await page.waitForTimeout(50);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
});

test("a short Difficulty list stays inside a short window", async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 900, height: 380 });
  await page.getByRole("button", { name: "Difficulty", exact: true }).click();
  const list = (await page.getByRole("listbox", { name: "Difficulty" }).boundingBox())!;
  expect(list.y + list.height).toBeLessThanOrEqual(380);
});

test("games with no difficulty don't offer one", async ({ page }) => {
  await open(page);
  const difficulty = page.locator("[data-fork-chip-select='Difficulty']");
  await expect(difficulty).toBeVisible();
  await pickGame(page, "garden");
  await expect(difficulty).toHaveCount(0);
  await pickGame(page, "chess");
  await expect(difficulty).toBeVisible();
});

test("controls and agent activity share the foot, both in view", async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    (window as unknown as { __setAgents(a: number, b: number): void }).__setAgents(3, 0),
  );
  const foot = page.locator("[data-fork-games-foot]");
  await expect(foot).toContainText("up rotates · space drops");
  await expect(foot).toContainText("3 agents working");
  // One row of chrome above the game: the picker and the score sit level.
  const chip = (await gameSelect(page).boundingBox())!;
  const readout = (await page.locator("[data-fork-games-score]").boundingBox())!;
  expect(Math.abs(chip.y + chip.height / 2 - (readout.y + readout.height / 2))).toBeLessThan(2);
});

test("Play again starts a finished game over from the card", async ({ page }) => {
  await open(page);
  const status = page.getByRole("status");
  for (let i = 0; i < 40 && !(await status.count()); i++) {
    await page.keyboard.press(" ");
    await page.waitForTimeout(50);
  }
  await expect(status).toHaveText(/game over/);
  await page.locator("[data-fork-games-again]").click();
  await expect(status).toHaveCount(0);
  await expect(board(page)).toBeFocused();
  await expect(pauseChip(page)).toBeVisible();
});

test("an agent needing you offers its session, and keep playing resumes", async ({ page }) => {
  await open(page);
  const set = (working: number, waiting: number) =>
    page.evaluate(
      ([a, b]) =>
        (window as unknown as { __setAgents(a: number, b: number): void }).__setAgents(a!, b!),
      [working, waiting],
    );

  await set(0, 1);
  await expect(page.getByRole("status")).toHaveText("An agent needs you");
  await page.getByRole("button", { name: "Keep playing" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(board(page)).toBeFocused();

  await set(1, 0);
  await set(0, 0);
  await expect(page.getByRole("status")).toHaveText("Agents finished");
  await expect(page.locator("[data-fork-games-open-session]")).toHaveCount(0);
  await page.getByRole("button", { name: "Keep playing" }).click();

  // Floating, it gets out of the way of the session it just opened.
  await set(0, 1);
  await page.locator("[data-fork-games-open-session]").click();
  await expect(panel(page)).toBeHidden();

  // Side by side, the app is already there, so the game stays.
  await set(0, 0);
  await page.locator("[data-fork-games]").click();
  await page.locator("[data-fork-games-dock]").click();
  await set(0, 1);
  await page.locator("[data-fork-games-open-session]").click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("the foot's waiting line opens the session too", async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    (window as unknown as { __setAgents(a: number, b: number): void }).__setAgents(1, 1),
  );
  await page.getByRole("button", { name: "Keep playing" }).click();
  await page.getByRole("button", { name: "1 agent working · 1 needs you" }).click();
  await expect(panel(page)).toBeHidden();
});

test("dragging moves only the panel until the drag ends, side by side", async ({ page }) => {
  await open(page);
  await page.locator("[data-fork-games-dock]").click();
  const appRoot = page.locator("#root");
  const app = (await appRoot.boundingBox())!;
  const edge = (await page.locator('[data-fork-games-resize-edge="left"]').boundingBox())!;
  await page.mouse.move(edge.x + 2, edge.y + 100);
  await page.mouse.down();
  await page.mouse.move(edge.x - 98, edge.y + 100, { steps: 4 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  // The panel follows the pointer; the app reflows once, on release.
  expect((await panel(page).boundingBox())!.x).toBeLessThan(edge.x - 50);
  expect((await appRoot.boundingBox())!.width).toBe(app.width);
  await page.mouse.up();
  expect((await appRoot.boundingBox())!.width).toBe(app.width - 100);
});
