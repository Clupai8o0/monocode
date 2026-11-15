import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const strip = '[data-fork-background-agents] > button';
const board = "[data-fork-agents-board]";

for (const theme of ["dark", "light"] as const) {
  test(`agents board, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/tests/browser/agents-board.html?theme=${theme}`);

    // Opens onto the board when work appears so steps stay in view.
    await expect(page.locator(board)).toBeVisible();
    await expect(page.locator(strip)).toContainText("2 of 5 agents done, 1 command running");
    await expect(page.locator(strip)).toContainText("1 failed");
    await page.screenshot({ path: `${dir}/agents-strip-${theme}.png` });
    await expect(page.locator(board)).toBeVisible();
    // Opened, it scrolls inside a small panel instead of pushing the chat up.
    expect((await page.locator(board).boundingBox())!.height).toBeLessThanOrEqual(352);
    await expect(page.getByText("Done · 14 steps")).toBeVisible();
    await expect(page.getByText("Failed", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Run npm test -- --run src\/features\/auth\/ --reporter=dot$/)).toBeVisible();
    await expect(page.getByText("Starting…")).toBeVisible();
    // Quiet is about the long build; the one with fresh steps says nothing.
    await expect(page.getByText(/No new step for \dm/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Show Long build check's work" })).toContainText(/No new step for/);
    await expect(page.getByText("npm run dev -- --port 1420")).toBeVisible();
    await page.screenshot({ path: `${dir}/agents-board-${theme}.png` });

    // Every lane spans the same stretch of clock, whatever its elapsed text.
    const lanes = page.locator(`${board} svg[height="12"]`);
    const boxes = await lanes.evaluateAll((all) =>
      all.map((lane) => {
        const box = lane.getBoundingClientRect();
        return [box.left, box.width];
      }),
    );
    expect(boxes.length).toBe(5);
    for (const box of boxes) {
      expect(box).toEqual(boxes[0]);
    }

    // Rows stay put as a step arrives.
    const names = () => page.locator(`${board} .text-\\[13px\\]`).allTextContents();
    const before = await names();
    await page.evaluate(() => (window as unknown as { __addStep: () => void }).__addStep());
    await expect(page.getByText("Read the newest step")).toBeVisible();
    expect(await names()).toEqual(before);

    // A row with nothing yet is not a button; one with a trail opens in place.
    await expect(page.getByRole("button", { name: /Write the changelog/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Show Migration audit's work" }).click();
    await expect(page.getByText("Rate limited after 3 retries.")).toBeVisible();
    await page.screenshot({ path: `${dir}/agents-board-row-${theme}.png` });
    await page.getByRole("button", { name: "Hide Migration audit's work" }).click();

    // A running command opens in place to show all of itself.
    await page.getByRole("button", { name: "Show command: npm run dev -- --port 1420" }).click();
    await expect(page.locator(`${board} pre`)).toHaveText("npm run dev -- --port 1420");
    await expect(page.locator(`${board} pre`)).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("Its output appears in the transcript when it finishes.")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `${dir}/agents-board-command-${theme}.png` });
    await page.getByRole("button", { name: "Hide command: npm run dev -- --port 1420" }).click();
    await expect(page.locator(`${board} pre`)).toHaveCount(0);

    // Escape closes it, and it stays closed.
    await page.locator(board).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(board)).toHaveCount(0);
    await expect(page.locator(strip)).toBeFocused();
    await page.waitForTimeout(1200);
    await expect(page.locator(board)).toHaveCount(0);
  });

  test(`agents board narrow, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/tests/browser/agents-board.html?theme=${theme}&width=420`);
    await expect(page.locator(board)).toBeVisible();
    const row = page.getByRole("button", { name: "Show Correctness review's work" });
    const svg = (await row.locator("svg:not(.size-3\\.5):not(.size-3)").last().boundingBox())!;
    const box = (await row.boundingBox())!;
    expect(svg.width).toBeGreaterThan(box.width * 0.8);
    await page.screenshot({ path: `${dir}/agents-board-narrow-${theme}.png` });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`a running command's output, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    const print = (lines: number) =>
      page.evaluate((count) => {
        (window as unknown as { __print(count: number): void }).__print(count);
      }, lines);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/tests/browser/agents-board.html?scene=output&theme=${theme}`);
    await expect(page.locator(board)).toBeVisible();
    await page.getByRole("button", { name: "Show command: cd src-tauri" }).click();

    // The whole script, not only its first line.
    const view = page.locator("[data-fork-command-console]");
    await expect(view.locator("pre").first()).toContainText("cat target/report.txt");
    await expect(page.getByText("No output yet.")).toBeVisible();

    await print(3);
    await expect(view).toContainText("Compiling crate-3 v1.0.0");
    await expect(view).not.toContainText("\u001b");
    await expect(page.getByText("No output yet.")).toHaveCount(0);

    // It follows new lines. The newest one is in plain sight, and the panel
    // stays its small size without scrolling on its own.
    await print(40);
    await expect(view).toContainText("crate-43");
    const distance = () =>
      view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(distance).toBeLessThan(8);
    const panel = page.locator(board);
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(352);
    expect(await panel.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    await page.screenshot({ path: `${dir}/agents-board-output-${theme}.png` });

    // The note about a cut pushes the output down, and it still ends in sight.
    await page.evaluate(() => {
      (window as unknown as { __cut(): void }).__cut();
    });
    await expect(view).toContainText("Earlier output left out.");
    await expect.poll(distance).toBeLessThan(8);

    // Scrolled up to read, the view stays put as more arrives.
    await view.evaluate((el) => {
      el.scrollTop = 0;
    });
    await print(10);
    await expect(view).toContainText("crate-53");
    expect(await view.evaluate((el) => el.scrollTop)).toBe(0);
  });
}

test("a command's newest output stays in sight among other rows", async ({ page }) => {
  const print = (lines: number) =>
    page.evaluate((count) => {
      (window as unknown as { __print(count: number): void }).__print(count);
    }, lines);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/tests/browser/agents-board.html?scene=output-among");
  await expect(page.locator(board)).toBeVisible();
  await page.getByRole("button", { name: "Show command: npm test" }).click();
  const view = page.locator("[data-fork-command-console]");
  const panel = page.locator(board);
  const overhang = async () => {
    const shown = (await panel.boundingBox())!;
    const box = (await view.boundingBox())!;
    return box.y + box.height - (shown.y + shown.height);
  };

  // As it grows, the panel moves to keep its end showing.
  await print(1);
  await expect(view).toContainText("crate-1 ");
  await print(40);
  await expect(view).toContainText("crate-41 ");
  await expect.poll(overhang).toBeLessThanOrEqual(1);
  await expect
    .poll(() => view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(8);

  // Once full, it leaves the panel alone for whoever is reading other rows.
  await panel.evaluate((el) => {
    el.scrollTop = 0;
  });
  await print(5);
  await expect(view).toContainText("crate-46 ");
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);
});

test("sequential runs open onto the board", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=sequential");
  await expect(page.locator(strip)).toContainText("1 of 2 agents done");
  await expect(page.locator(board)).toBeVisible();
});

test("the tray clears once all work has finished", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=alldone");
  await expect(page.locator("[data-switch-session]")).toBeVisible();
  await expect(page.locator(strip)).toHaveCount(0);
});

test("a single agent keeps the tray's wording", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=single");
  await expect(page.locator(strip)).toContainText("1 agent running");
  await expect(page.locator(board)).toBeVisible();
});

test("the toggle does not leak between sessions", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html");
  await expect(page.locator(board)).toBeVisible();
  await page.locator(board).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(board)).toHaveCount(0);
  await page.locator("[data-switch-session]").click();
  // A remounted tray opens for its own work; the prior collapse stays behind.
  await expect(page.locator(board)).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`a job's stop control says what it does, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.goto(`/tests/browser/agents-board.html?scene=jobs&theme=${theme}`);
    await expect(page.locator(strip)).toContainText("3 jobs running");
    const stops = page.getByRole("button", { name: /^Stop(ping)? / });
    await expect(stops).toHaveCount(3);
    await expect(stops.first()).toHaveText("Stop");
    await page.screenshot({ path: `${dir}/jobs-${theme}.png` });

    await stops.first().click();
    await expect(stops.first()).toHaveText("Stopping…");
    await expect(stops.first()).toBeDisabled();
    await expect(stops.nth(1)).toBeEnabled();
    await stops.nth(1).hover();
    await page.screenshot({ path: `${dir}/jobs-stopping-${theme}.png` });

    // Squeezed, the command gives way; the button keeps its word.
    await page.goto(`/tests/browser/agents-board.html?scene=jobs&theme=${theme}&width=420`);
    await expect(stops.first()).toHaveText("Stop");
    await expect(stops.first()).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `${dir}/jobs-narrow-${theme}.png` });
  });
}
