import { expect, test } from "@playwright/test";

// LAB_BROWSER: a Chromium to run when the one Playwright expects is not
// downloaded; LAB_SHOTS: a folder for the screenshots.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const table = "[data-fork-code-table]";
const editor = "[data-fork-code-editor]";

for (const theme of ["dark", "light"] as const) {
  test(`code drills, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/tests/browser/code-drills.html?theme=${theme}`);

    await expect(page.locator(table)).toBeVisible();
    await expect(page.locator(table)).toContainText("Add two numbers");
    const solutionButton = page.getByRole("button", { name: "Show solution" });
    await expect(solutionButton).toBeDisabled();
    await expect(page.locator("[data-fork-code-solution]")).toHaveCount(0);
    await page.screenshot({ path: `${dir}/code-drills-${theme}.png` });

    // Typing in the editor never reaches the page's game keys.
    await page.locator(editor).click();
    await page.keyboard.type("wasd");
    expect(
      await page.evaluate(
        () => (window as unknown as { gameKeys: string[] }).gameKeys,
      ),
    ).toEqual([]);

    // A wrong answer shows the failures, twice, and only then the solution.
    await page.locator(editor).fill("function add(a, b) {\n  return a;\n}\n");
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.locator('[data-fork-code-result="0"]')).toContainText("Fail");
    await expect(page.locator('[data-fork-code-result="0"]')).toContainText(
      "expected 3, got 1",
    );
    await expect(solutionButton).toBeDisabled();
    await page.getByRole("button", { name: "Run" }).click();
    await expect(solutionButton).toBeEnabled();
    await solutionButton.click();
    await expect(page.locator("[data-fork-code-solution]")).toContainText(
      "return a + b;",
    );

    // The right answer scores: third try, no hints, so 80 points.
    await page.locator(editor).fill("function add(a, b) {\n  return a + b;\n}\n");
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.locator("[data-fork-code-score]")).toHaveText(
      "Solved. 80 points.",
    );
    await expect(page.locator("[data-fork-code-points]")).toHaveText("points 80");
    await page.screenshot({ path: `${dir}/code-drills-solved-${theme}.png` });

    // Next drill, one hint, first try: 75 points, less for the hint.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator(table)).toContainText("Shout a word");
    await page.getByRole("button", { name: "Hint" }).click();
    await expect(page.locator(table)).toContainText("Hint: Strings have toUpperCase()");
    await page
      .locator(editor)
      .fill("function shout(word) {\n  return word.toUpperCase() + \"!\";\n}\n");
    await page.locator(editor).press("ControlOrMeta+Enter");
    await expect(page.locator("[data-fork-code-score]")).toHaveText(
      "Solved. 75 points.",
    );
    await expect(page.locator("[data-fork-code-points]")).toHaveText("points 155");
    await expect(page.locator("[data-fork-code-stats]")).toContainText(
      "solved today 2",
    );

    // Ask Dojo asks the app to open the Mono.
    await page.getByRole("button", { name: "Ask Dojo" }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as { dojoOpened: boolean }).dojoOpened,
      ),
    ).toBe(true);
  });
}
