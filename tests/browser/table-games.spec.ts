import { expect, test, type Page } from "@playwright/test";

// GAME_SHOTS: a folder for the screenshots. GAME_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.GAME_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.GAME_BROWSER } });
}

const THEMES = ["dark", "light"] as const;

async function open(page: Page, tab: string, query = "", theme = "dark") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/tests/browser/table-games.html?theme=${theme}${query}`);
  await page.locator("[data-fork-games]").click();
  const panel = page.getByRole("dialog", { name: "Games" });
  await expect(panel).toBeVisible();
  await page.getByRole("tab", { name: tab }).click();
  return panel;
}

async function shoot(page: Page, name: string, dir: string) {
  await page.screenshot({
    path: `${dir}/${name}.png`,
    clip: { x: 1280 - 760, y: 800 - 620, width: 760, height: 620 },
  });
}

const tokens = async (page: Page) =>
  Number(await page.locator("[data-fork-games-score]").getAttribute("data-fork-games-score"));

const phase = (page: Page, game: string) =>
  page.locator(`[data-table-board="${game}"] [data-table-phase]`);

/** Plays a poker hand to the end, calling everything, by keyboard. */
async function playPokerHand(page: Page, key = "c") {
  const board = phase(page, "Poker table");
  const deadline = Date.now() + 90_000;
  while ((await board.getAttribute("data-table-phase")) !== "done") {
    expect(Date.now(), "hand never finished").toBeLessThan(deadline);
    if (await page.locator('[data-action="call"]').isVisible()) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(150);
  }
}

for (const theme of THEMES) {
  test(`poker, ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const panel = await open(page, "poker", "", theme);
    expect((await panel.boundingBox())!.width).toBe(720);
    expect((await panel.boundingBox())!.height).toBe(560);
    await expect(page.locator('[data-table-board="Poker table"]')).toBeFocused();
    expect(await tokens(page)).toBe(10_000);
    await shoot(page, `poker-idle-${theme}`, dir);

    await page.keyboard.press(" ");
    await expect(phase(page, "Poker table")).toHaveAttribute("data-table-phase", "preflop");
    // Your two cards are face up; no agent's cards are in the page at all.
    await expect(page.locator("[data-you-cards] [data-card]")).toHaveCount(2);
    await expect(page.locator('[data-you-cards] [data-card="back"]')).toHaveCount(0);
    await expect(page.locator('[data-seat]:not([data-seat="you"]) [data-card]:not([data-card="back"])')).toHaveCount(0);

    await expect(page.locator("[data-table-thinking]").first()).toContainText(/thinking · .* tokens/);
    await shoot(page, `poker-thinking-${theme}`, dir);

    await expect(page.locator('[data-action="call"]')).toBeVisible({ timeout: 30_000 });
    await shoot(page, `poker-your-turn-${theme}`, dir);

    // The raise control: the presets move the slider, R plays it.
    if (await page.locator('[data-action="pot"]').isVisible()) {
      await page.locator('[data-action="pot"]').click();
      await expect(page.locator('[data-action="raise"]')).toContainText(/Raise to|All in/);
      await page.keyboard.press("r");
    } else {
      await page.keyboard.press("c");
    }
    await playPokerHand(page);
    await expect(page.locator("[data-table-status]").first()).not.toBeEmpty();
    await shoot(page, `poker-result-${theme}`, dir);

    // Tokens are what's on the table: the stack, the bankroll, the score row agree.
    const after = await tokens(page);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("monocode.fork.games.tokens")!));
    expect(saved.tokens).toBe(after);

    // A folded hand: F, and the next hand goes by Space.
    await page.keyboard.press(" ");
    await expect(page.locator('[data-action="fold"]')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("f");
    await expect(phase(page, "Poker table")).toHaveAttribute("data-table-phase", "done", { timeout: 60_000 });
    expect(errors).toEqual([]);
  });

  test(`blackjack, ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "blackjack", "", theme);
    const start = await tokens(page);
    await shoot(page, `blackjack-bet-${theme}`, dir);

    // The bet moves by the table minimum.
    await page.locator('[data-action="bet-up"]').click();
    await expect(page.locator("[data-your-bet]")).toHaveAttribute("data-your-bet", "200");
    await page.locator('[data-action="bet-down"]').click();
    await expect(page.locator("[data-your-bet]")).toHaveAttribute("data-your-bet", "100");

    const board = phase(page, "Blackjack table");
    for (let round = 0; round < 3; round++) {
      await page.keyboard.press(" ");
      await expect(board).not.toHaveAttribute("data-table-phase", "betting");
      for (let turn = 0; turn < 60; turn++) {
        if ((await board.getAttribute("data-table-phase")) === "settled") {
          break;
        }
        if (await page.locator('[data-action="hit"]').isVisible()) {
          if (round === 0) {
            await shoot(page, `blackjack-your-turn-${theme}`, dir);
          }
          // One hit on the first round, then stand.
          await page.keyboard.press(round === 0 && turn < 25 ? "h" : "s");
          await page.waitForTimeout(100);
          await page.keyboard.press("s");
        }
        await page.waitForTimeout(200);
      }
      await expect(board).toHaveAttribute("data-table-phase", "settled", { timeout: 30_000 });
    }
    await shoot(page, `blackjack-result-${theme}`, dir);

    // Whatever happened, what you have and what's stored agree.
    const after = await tokens(page);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("monocode.fork.games.tokens")!));
    expect(saved.tokens).toBe(after);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(start).toBe(10_000);
    expect(errors).toEqual([]);
  });

  test(`chess, ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "chess", "", theme);
    await expect(page.locator("[data-chess-board]")).toHaveAttribute("data-chess-board", "white");
    await shoot(page, `chess-start-${theme}`, dir);

    // Click to move: dots appear, and the agent answers from its worker.
    await page.locator('[data-square="e2"]').click();
    await expect(page.locator("[data-legal-dot]")).toHaveCount(2);
    await shoot(page, `chess-selected-${theme}`, dir);
    await page.locator('[data-square="e4"]').click();
    await expect(page.locator('[data-square="e4"]')).toHaveAttribute("data-piece", "1");
    await expect(page.locator("[data-move-list]")).toContainText("e2e4");
    await expect.poll(async () => (await page.locator("[data-move-list]").innerText()).split(" ").length, { timeout: 15_000 }).toBe(2);

    // Drag to move.
    const from = (await page.locator('[data-square="d2"]').boundingBox())!;
    const to = (await page.locator('[data-square="d4"]').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('[data-square="d4"]')).toHaveAttribute("data-piece", "1");
    await expect.poll(async () => (await page.locator("[data-move-list]").innerText()).split(" ").length, { timeout: 15_000 }).toBe(4);
    await shoot(page, `chess-midgame-${theme}`, dir);

    // Resigning ends it and goes on the record.
    await page.locator('[data-action="resign"]').click();
    await expect(page.locator("[data-table-status]").last()).toContainText("You resigned");
    await expect(page.locator("[data-chess-record]")).toBeVisible();
    await shoot(page, `chess-over-${theme}`, dir);
    expect(errors).toEqual([]);
  });
}

test("chess promotion picker, and mate is seen", async ({ page }, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await page.emulateMedia({ reducedMotion: "reduce" });
  // White pawn on a7, one move from promoting, with mate on the back rank.
  await open(page, "chess", `&fen=${encodeURIComponent("7k/P5pp/8/8/8/8/8/6K1 w - - 0 1")}`);
  await page.locator('[data-square="a7"]').click();
  await page.locator('[data-square="a8"]').click();
  await expect(page.locator("[data-promotion]")).toBeVisible();
  await shoot(page, "chess-promotion-dark", dir);
  await page.locator('[data-promote="queen"]').click();
  await expect(page.locator('[data-square="a8"]')).toHaveAttribute("data-piece", "5");
  await expect(page.locator("[data-table-status]").last()).toContainText(/Checkmate. You win/);
});

test("keys belong to the board only while it has focus; notices still show", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "poker");
  await page.keyboard.press(" ");
  await expect(page.locator('[data-action="fold"]')).toBeVisible({ timeout: 30_000 });

  // The composer keeps its letters, and no action happens.
  const composer = page.getByRole("textbox", { name: "Composer" });
  await composer.click();
  await page.keyboard.type("fcra");
  await expect(composer).toHaveValue("fcra");
  await expect(page.locator('[data-action="fold"]')).toBeVisible();

  // An agent's waiting: the notice shows, and a seated agent passes it on.
  await page.locator('[data-table-board="Poker table"]').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => (window as never as { __setAgents: (a: number, b: number) => void }).__setAgents(1, 1));
  await expect(page.getByRole("status").filter({ hasText: "An agent needs you" })).toBeVisible();
  await page.locator('[data-table-board="Poker table"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("status").filter({ hasText: "An agent needs you" })).toHaveCount(0);

  // New game hands the keys back to the table, not the composer.
  await composer.click();
  await page.getByRole("button", { name: "New game" }).click();
  await expect(page.locator('[data-table-board="Poker table"]')).toBeFocused();

  // Esc hides the panel.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Games" })).toBeHidden();
});

test("agents stop while the panel's hidden, and the hand is there on return", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "poker");
  await page.keyboard.press(" ");
  await expect(page.locator('[data-action="fold"]')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("c");
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  const street = await phase(page, "Poker table").getAttribute("data-table-phase");
  const pot = await page.locator("[data-pot]").textContent();
  await page.waitForTimeout(3000);
  expect(await phase(page, "Poker table").getAttribute("data-table-phase")).toBe(street);
  expect(await page.locator("[data-pot]").textContent()).toBe(pot);
  await page.locator("[data-fork-games]").click();
  await expect(page.locator('[data-table-board="Poker table"]')).toBeFocused();
});

test("broke: a quota bump refills, and the grid games still work", async ({ page }, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/browser/table-games.html");
  await page.evaluate(() =>
    localStorage.setItem("monocode.fork.games.tokens", JSON.stringify({ tokens: 3, peak: 15000 })),
  );
  await page.reload();
  await page.locator("[data-fork-games]").click();
  await page.getByRole("tab", { name: "blackjack" }).click();
  await expect(page.locator('[data-action="bump"]')).toBeVisible();
  await shoot(page, "blackjack-broke-dark", dir);
  await page.locator('[data-action="bump"]').click();
  expect(await tokens(page)).toBe(5003);
  await expect(page.locator('[data-action="deal"]').last()).toBeVisible();

  // Back to a grid game: it takes the keys, and the last game is remembered.
  await page.getByRole("tab", { name: "snake" }).click();
  await expect(page.locator("[data-grid-board]")).toBeFocused();
  expect((await page.getByRole("dialog", { name: "Games" }).boundingBox())!.width).toBe(600);
  await page.getByRole("tab", { name: "chess" }).click();
  await page.reload();
  await page.locator("[data-fork-games]").click();
  await expect(page.getByRole("tab", { name: "chess" })).toHaveAttribute("aria-selected", "true");
});

test("with motion on: coins land and clear, and chess runs in a worker", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await open(page, "poker");
  await page.keyboard.press(" ");
  await page.waitForTimeout(90);
  await shoot(page, "poker-motion-dark", dir);
  await playPokerHand(page);
  await page.waitForTimeout(800);
  // Nothing's left behind on the table from the flying coins.
  await expect(page.locator('[data-table-phase] > svg[aria-hidden="true"]')).toHaveCount(0);

  await page.getByRole("tab", { name: "chess" }).click();
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect.poll(async () => (await page.locator("[data-move-list]").innerText()).split(" ").length, { timeout: 15_000 }).toBe(2);
  expect(workers.some((url) => url.includes("chessEngine.worker"))).toBe(true);
  expect(errors).toEqual([]);
});

test("a small window still fits every control", async ({ page }, testInfo) => {
  const dir = process.env.GAME_SHOTS ?? testInfo.outputDir;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto("/tests/browser/table-games.html");
  await page.locator("[data-fork-games]").click();
  await page.getByRole("tab", { name: "poker" }).click();
  await page.keyboard.press(" ");
  await expect(page.locator('[data-action="fold"]')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${dir}/poker-small-window.png` });
  const panel = (await page.getByRole("dialog", { name: "Games" }).boundingBox())!;
  for (const action of ["fold", "call"]) {
    const box = (await page.locator(`[data-action="${action}"]`).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
  }
  await page.getByRole("tab", { name: "chess" }).click();
  await page.screenshot({ path: `${dir}/chess-small-window.png` });
  const board = (await page.locator("[data-chess-board]").boundingBox())!;
  expect(board.y + board.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(board.width % 96).toBe(0);
});

test("only one card game holds chips at a time, and New game leaves a parked grid game", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "poker");
  await page.keyboard.press(" ");
  await expect(page.locator('[data-action="fold"]')).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: "blackjack" }).click();
  await expect(page.locator('[data-table-board="Blackjack table"]')).toBeFocused();
  await page.keyboard.press(" ");
  await expect(phase(page, "Blackjack table")).toHaveAttribute("data-table-phase", "idle");
  await expect(page.locator('[data-table-board="Blackjack table"] [data-table-status]')).toHaveText("Finish your poker hand first.");

  // Finish the hand, and blackjack opens up.
  await page.getByRole("tab", { name: "poker" }).click();
  await page.keyboard.press("f");
  await expect(phase(page, "Poker table")).toHaveAttribute("data-table-phase", "done", { timeout: 60_000 });
  await page.getByRole("tab", { name: "blackjack" }).click();
  await page.keyboard.press(" ");
  await expect(phase(page, "Blackjack table")).not.toHaveAttribute("data-table-phase", "idle");

  // A grid game's score survives New game at a table.
  await page.getByRole("tab", { name: "agent run" }).click();
  await expect(page.locator("[data-grid-board]")).toBeFocused();
  await page.keyboard.press(" ");
  await expect.poll(() => tokens(page), { timeout: 8000 }).toBeGreaterThan(2);
  const before = await tokens(page);
  await page.getByRole("tab", { name: "chess" }).click();
  await page.getByRole("button", { name: "New game" }).click();
  await page.getByRole("tab", { name: "agent run" }).click();
  expect(await tokens(page)).toBeGreaterThanOrEqual(before);
});
