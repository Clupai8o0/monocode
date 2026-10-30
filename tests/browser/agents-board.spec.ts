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

    // Overlapping runs open by themselves.
    await expect(page.locator(board)).toBeVisible();
    await expect(page.locator(strip)).toContainText("2 of 5 agents done, 1 command running");
    await expect(page.locator(strip)).toContainText("1 failed");
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

    // The user's toggle wins.
    await page.locator(strip).click();
    await expect(page.locator(board)).toHaveCount(0);
    await page.waitForTimeout(1200);
    await expect(page.locator(board)).toHaveCount(0);
    await page.screenshot({ path: `${dir}/agents-strip-${theme}.png` });
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

test("sequential runs stay closed", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=sequential");
  await expect(page.locator(strip)).toContainText("1 of 2 agents done");
  await expect(page.locator(board)).toHaveCount(0);
});

test("a finished board stays up, closed, and keeps its wording", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=alldone");
  await expect(page.locator(strip)).toContainText("2 of 2 agents done");
  await expect(page.locator(strip)).toContainText("1 failed");
  await expect(page.locator(board)).toHaveCount(0);
});

test("a single agent keeps the tray's wording", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html?scene=single");
  await expect(page.locator(strip)).toContainText("1 agent running");
  await expect(page.locator(board)).toHaveCount(0);
});

test("the toggle does not leak between sessions", async ({ page }) => {
  await page.goto("/tests/browser/agents-board.html");
  await page.locator(strip).click();
  await expect(page.locator(board)).toHaveCount(0);
  await page.locator("[data-switch-session]").click();
  await expect(page.locator(board)).toBeVisible();
});
