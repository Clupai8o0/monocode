import { expect, test, type Page } from "@playwright/test";

// LAB_BROWSER: a Chromium to run when the one Playwright expects is not
// downloaded; LAB_SHOTS: a folder for the screenshots.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const table = "[data-fork-code-table]";
const editor = "[data-fork-code-editor]";

type Lab = {
  setActive: (active: boolean) => void;
  newRun: () => void;
  setDojoTitle: (title: string) => void;
  setDojoAvailable: (available: boolean) => void;
  openPanel: () => void;
  panelOpen: () => boolean;
  loads: () => number;
  dojoOpened: () => boolean;
};

/** The controls the page's LabHarness publishes as window.lab. */
function labOf(page: Page) {
  return {
    setActive: (active: boolean) =>
      page.evaluate(
        (value) => (window as unknown as { lab: Lab }).lab.setActive(value),
        active,
      ),
    newRun: () =>
      page.evaluate(() => (window as unknown as { lab: Lab }).lab.newRun()),
    setDojoTitle: (title: string) =>
      page.evaluate(
        (value) => (window as unknown as { lab: Lab }).lab.setDojoTitle(value),
        title,
      ),
    setDojoAvailable: (available: boolean) =>
      page.evaluate(
        (value) => (window as unknown as { lab: Lab }).lab.setDojoAvailable(value),
        available,
      ),
    openPanel: () =>
      page.evaluate(() => (window as unknown as { lab: Lab }).lab.openPanel()),
    panelOpen: () =>
      page.evaluate(() => (window as unknown as { lab: Lab }).lab.panelOpen()),
    loads: () =>
      page.evaluate(() => (window as unknown as { lab: Lab }).lab.loads()),
    dojoOpened: () =>
      page.evaluate(() => (window as unknown as { lab: Lab }).lab.dojoOpened()),
  };
}

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

test("code drills reload when the tab becomes active", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  const lab = labOf(page);
  await expect(page.locator(table)).toContainText("Add two numbers");

  // Code typed while parked must survive the reload.
  await page.locator(editor).fill("function add(a, b) {\n  return a + b;\n}\n");
  await lab.setActive(true);
  await expect.poll(() => lab.loads()).toBe(1);

  await lab.setActive(false);
  await lab.setDojoTitle("Add two numbers, from Dojo");
  await lab.setActive(true);
  await expect.poll(() => lab.loads()).toBe(2);
  await expect(page.locator(table)).toContainText("Add two numbers, from Dojo");
  expect(await page.locator(editor).inputValue()).toContain("return a + b;");
});

test("a run re-reads saved progress before scoring", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);
  await expect(page.locator(table)).toContainText("Add two numbers");

  // Another window banks 40 points after this one mounted.
  await page.evaluate(() => {
    localStorage.setItem(
      "monocode.fork.games.code.progress",
      JSON.stringify({ totalPoints: 40, drills: {}, solvedByDay: {} }),
    );
  });
  await page.locator(editor).fill("function add(a, b) {\n  return a + b;\n}\n");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-fork-code-score]")).toHaveText(
    "Solved. 100 points.",
  );
  await expect(page.locator("[data-fork-code-points]")).toHaveText("points 140");
});

test("a new game elsewhere leaves the hidden Code tab alone", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);
  await expect(page.locator(table)).toContainText("Add two numbers");

  await lab.setActive(false);
  await lab.newRun();
  await lab.setActive(true);
  await expect(page.locator(table)).toContainText("Add two numbers");

  // A run started while the tab is up still moves on.
  await lab.newRun();
  await expect(page.locator(table)).not.toContainText("Add two numbers");
});

test("Ask Dojo stays open when Dojo was removed", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);
  await lab.setDojoAvailable(false);
  await lab.openPanel();
  await page.getByRole("button", { name: "Ask Dojo" }).click();
  await expect(page.locator("[data-fork-code-note]")).toHaveText(
    "Dojo was removed.",
  );
  expect(await lab.panelOpen()).toBe(true);
  expect(await lab.dojoOpened()).toBe(false);
});

test("says when the output was cut", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);
  await expect(page.locator(table)).toContainText("Add two numbers");
  await page.locator(editor).fill("function add(a, b) {\n  return a + b;\n}\n");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-fork-code-output]")).toContainText(
    "Earlier output was cut; this is the last 64 KB.",
  );
});
