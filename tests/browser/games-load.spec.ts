import { expect, test, type Page } from "@playwright/test";

const arcadeModule = /\/(?:pacman|snake|blocks|runner|platformer|stack|sand|rain)Arcade\.ts(?:\?|$)/;

async function pickGame(page: Page, name: string)
{
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("games stay unloaded until opened, then only the selected arcade loads", async ({ page }) => {
  const modules: string[] = [];
  page.on("request", (request) => modules.push(new URL(request.url()).pathname));
  await page.goto("/tests/browser/games-panel.html");
  await expect(page.locator("[data-fork-games]")).toBeVisible();
  expect(modules.filter((url) => /PokerTable|CodeTable|chessAi|Arcade\.ts/.test(url))).toEqual([]);
  expect(modules.filter((url) => /GamesPanel\.tsx/.test(url))).toEqual([]);

  await page.locator("[data-fork-games]").click();
  await expect(page.getByRole("dialog", { name: "Games" })).toBeVisible();
  await expect.poll(() => modules.filter((url) => arcadeModule.test(url))).toEqual([
    "/src/fork/games/blocksArcade.ts",
  ]);
  expect(modules.filter((url) => /PokerTable|CodeTable|chessAi/.test(url))).toEqual([]);
  await expect(page.locator("[data-grid-board] canvas")).toHaveCount(1);

  await pickGame(page, "snake");
  await expect.poll(() => modules.filter((url) => arcadeModule.test(url))).toEqual([
    "/src/fork/games/blocksArcade.ts",
    "/src/features/terminal/arcade/snakeArcade.ts",
  ]);
  await expect(page.locator("[data-grid-board] canvas")).toHaveCount(2);
  await pickGame(page, "blocks");
  await expect(page.locator("[data-grid-board] canvas")).toHaveCount(2);
});

test("a remembered table does not load an arcade or another table", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("monocode.fork.games.last", "poker"));
  const modules: string[] = [];
  page.on("request", (request) => modules.push(new URL(request.url()).pathname));
  await page.goto("/tests/browser/games-panel.html");
  await page.locator("[data-fork-games]").click();
  await expect(page.locator("[data-table-active] [data-table-board]")).toBeVisible();
  expect(modules.some((url) => /PokerTable/.test(url))).toBe(true);
  expect(modules.filter((url) => arcadeModule.test(url) || /CodeTable|chessAi|GardenTable/.test(url))).toEqual([]);
  await expect(page.locator("[data-grid-board] canvas")).toHaveCount(0);
});

test("a slow panel import uses the latest toggle state", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/GamesPanel.tsx*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/tests/browser/games-panel.html");
  const button = page.locator("[data-fork-games]");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  release();
  await expect(page.locator("[data-fork-games-root]")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Games" })).toBeHidden();
});
