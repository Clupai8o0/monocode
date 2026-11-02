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

test("sudoku fills, notes, undoes, keeps the board and solves", async ({ page }, testInfo) => {
  const errors = await open(page, "sudoku");
  const board = page.locator("[data-table-board='Sudoku']");
  await board.focus();
  await shot(page, "sudoku-start", testInfo.outputDir);

  const givenCount = await page.locator("[data-sudoku-given]").count();
  expect(givenCount).toBe(32);
  const left = page.locator("[data-sudoku-left]");
  await expect(left).toHaveAttribute("data-sudoku-left", String(81 - givenCount));

  // A given stays put when typed over.
  const given = page.locator("[data-sudoku-given]").first();
  const givenValue = await given.getAttribute("data-sudoku-value");
  await given.click();
  await page.keyboard.press(givenValue === "9" ? "1" : "9");
  await expect(given).toHaveAttribute("data-sudoku-value", givenValue!);

  // The arrows move the selection and a digit lands in it.
  const blank = page.locator("[data-sudoku-cell]:not([data-sudoku-given])").first();
  const blankIndex = Number(await blank.getAttribute("data-sudoku-cell"));
  await blank.click();
  await page.keyboard.press("5");
  await expect(blank).toHaveAttribute("data-sudoku-value", "5");
  await expect(left).toHaveAttribute("data-sudoku-left", String(80 - givenCount));
  await page.keyboard.press("u");
  await expect(blank).toHaveAttribute("data-sudoku-value", "0");
  const rowStart = Math.floor(blankIndex / 9) * 9;
  const right = page.locator(`[data-sudoku-cell='${rowStart + ((blankIndex + 1) % 9)}']`);
  await page.keyboard.press("ArrowRight");
  await expect(right).toHaveAttribute("aria-pressed", "true");
  await blank.click();

  // Notes pencil in, the pad works, and a second note shows beside the first.
  await page.keyboard.press("n");
  await page.keyboard.press("3");
  await page.locator("[data-sudoku-pad='7']").click();
  await expect(blank).toHaveAttribute("data-sudoku-value", "0");
  await expect(blank).toContainText("3");
  await expect(blank).toContainText("7");
  await shot(page, "sudoku-notes", testInfo.outputDir);
  await page.keyboard.press("n");

  // Two of a digit in one row shows as a clash, and the board survives a reload.
  const rowCells = await Promise.all(
    Array.from({ length: 9 }, (_, i) => page.locator(`[data-sudoku-cell='${rowStart + i}']`).getAttribute("data-sudoku-value")),
  );
  const taken = rowCells.find((value) => value !== "0");
  expect(taken).toBeTruthy();
  await page.keyboard.press(taken!);
  await expect(blank).toHaveAttribute("data-sudoku-clash", "");
  await shot(page, "sudoku-clash", testInfo.outputDir);
  await page.reload();
  await expect(page.locator(`[data-sudoku-cell='${blankIndex}']`)).toHaveAttribute("data-sudoku-value", taken!);

  // Restart empties the board, U brings it back, and Backspace clears the cell.
  await page.locator(`[data-sudoku-cell='${blankIndex}']`).click();
  await page.locator("[data-action='restart']").click();
  await expect(page.locator(`[data-sudoku-cell='${blankIndex}']`)).toHaveAttribute("data-sudoku-value", "0");
  await page.keyboard.press("u");
  await expect(page.locator(`[data-sudoku-cell='${blankIndex}']`)).toHaveAttribute("data-sudoku-value", taken!);
  await page.locator(`[data-sudoku-cell='${blankIndex}']`).click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(`[data-sudoku-cell='${blankIndex}']`)).toHaveAttribute("data-sudoku-value", "0");
  expect(errors).toEqual([]);
});

test("a new game at another table leaves the sudoku board alone", async ({ page }) => {
  const errors = await open(page, "sudoku");
  const blank = page.locator("[data-sudoku-cell]:not([data-sudoku-given])").first();
  const index = await blank.getAttribute("data-sudoku-cell");
  const cell = page.locator(`[data-sudoku-cell='${index}']`);
  await blank.click();
  await page.keyboard.press("5");
  await expect(cell).toHaveAttribute("data-sudoku-value", "5");

  await page.locator("[data-fork-chip-select='Game']").click();
  await page.getByRole("option", { name: "colour sort" }).click();
  await expect(page.locator("[data-tube='0']")).toBeVisible();
  await page.getByRole("button", { name: "New game" }).click();
  // Give a wrongful restart time to reach the hidden board and its save.
  await page.waitForTimeout(300);
  await expect(cell).toHaveAttribute("data-sudoku-value", "5");

  await page.reload();
  await page.locator("[data-fork-chip-select='Game']").click();
  await page.getByRole("option", { name: "sudoku" }).click();
  await expect(cell).toHaveAttribute("data-sudoku-value", "5");

  // At its own table, new game does clear it.
  await page.getByRole("button", { name: "New game" }).click();
  await expect(cell).toHaveAttribute("data-sudoku-value", "0");
  expect(errors).toEqual([]);
});

test("sudoku solved board offers the next level", async ({ page }, testInfo) => {
  const errors = await open(page, "sudoku");
  await page.locator("[data-table-board='Sudoku']").focus();

  // Read the clues off the page, solve them here, and play the answer in.
  const values = await page.evaluate(() =>
    Array.from({ length: 81 }, (_, i) =>
      Number(document.querySelector(`[data-sudoku-cell='${i}']`)?.getAttribute("data-sudoku-value") ?? 0),
    ),
  );
  const solved = solveGrid(values);
  expect(solved).not.toBeNull();
  for (let i = 0; i < 81; i++) {
    if (values[i] === 0) {
      await page.locator(`[data-sudoku-cell='${i}']`).click();
      await page.keyboard.press(String(solved![i]));
    }
  }
  await expect(page.locator("[data-sudoku-solved]")).toHaveCount(1);
  await page.waitForTimeout(700);
  await shot(page, "sudoku-solved", testInfo.outputDir);
  await page.keyboard.press("n");
  await expect(page.getByText("Level 2")).toBeVisible();
  await expect(page.locator("[data-sudoku-solved]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

function solveGrid(grid: number[]): number[] | null {
  const cells = [...grid];
  const fits = (index: number, digit: number) => {
    const row = Math.floor(index / 9);
    const col = index % 9;
    for (let i = 0; i < 9; i++) {
      const boxCell = (Math.floor(row / 3) * 3 + Math.floor(i / 3)) * 9 + Math.floor(col / 3) * 3 + (i % 3);
      if (cells[row * 9 + i] === digit || cells[i * 9 + col] === digit || cells[boxCell] === digit) {
        return false;
      }
    }
    return true;
  };
  const step = (): boolean => {
    const index = cells.indexOf(0);
    if (index === -1) {
      return true;
    }
    for (let digit = 1; digit <= 9; digit++) {
      if (fits(index, digit)) {
        cells[index] = digit;
        if (step()) {
          return true;
        }
        cells[index] = 0;
      }
    }
    return false;
  };
  return step() ? cells : null;
}

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
