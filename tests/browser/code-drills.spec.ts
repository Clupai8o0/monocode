import { expect, test, type Page } from "@playwright/test";

// LAB_BROWSER: a Chromium to run when the one Playwright expects is not
// downloaded; LAB_SHOTS: a folder for the screenshots.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const table = "[data-fork-code-table]";
const editor = "[data-fork-code-editor]";

/** CodeMirror owns the textbox, so fill the document the way a person does. */
async function setCode(page: Page, text: string) {
  const box = page.locator(editor);
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

async function codeText(page: Page): Promise<string> {
  return page.locator(editor).innerText();
}

type Lab = {
  setActive: (active: boolean) => void;
  newRun: () => void;
  setDojoTitle: (title: string) => void;
  setDojoAvailable: (available: boolean) => void;
  setRunResult: (result: Partial<RunResult> | null) => void;
  openPanel: () => void;
  panelOpen: () => boolean;
  loads: () => number;
  dojoOpened: () => boolean;
};

type RunResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  truncated: boolean;
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
    setRunResult: (result: Partial<RunResult> | null) =>
      page.evaluate(
        (value) => (window as unknown as { lab: Lab }).lab.setRunResult(value),
        result,
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
    await setCode(page, "function add(a, b) {\n  return a;\n}\n");
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
    await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
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
    await setCode(
      page,
      "function shout(word) {\n  return word.toUpperCase() + \"!\";\n}\n",
    );
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

test("the editor highlights keywords and indents the next line", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");

  const colors = await page.locator(editor).evaluate((element) => {
    const keyword = [...element.querySelectorAll("span")].find(
      (span) => span.textContent === "function",
    );
    return {
      keyword: keyword ? getComputedStyle(keyword).color : null,
      plain: getComputedStyle(element).color,
    };
  });
  expect(colors.keyword).not.toBeNull();
  expect(colors.keyword).not.toBe(colors.plain);

  // JavaScript: Enter after an opening brace lands on an indented line.
  await setCode(page, "function add(a, b) {");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("return a + b;");
  expect((await codeText(page)).split("\n")[1]).toBe("  return a + b;");

  // Python: the same after a colon, with a four-space block.
  await page.getByRole("button", { name: "Python" }).click();
  await expect(page.locator(table)).toContainText("Add two numbers in Python");
  await setCode(page, "def add(a, b):");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("return a + b");
  expect((await codeText(page)).split("\n")[1]).toBe("    return a + b");
});

test("Format runs Prettier for JavaScript and re-indents Python", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(page, "function add(a,b){return a+b;}");
  await page.locator("[data-fork-code-format]").click();
  await expect
    .poll(async () => (await codeText(page)).trimEnd())
    .toBe("function add(a, b) {\n  return a + b;\n}");

  await page.getByRole("button", { name: "Python" }).click();
  await expect(page.locator(table)).toContainText("Add two numbers in Python");
  await setCode(page, "def add(a, b):\n  return a + b\n");
  await page.locator("[data-fork-code-format]").click();
  await expect
    .poll(async () => (await codeText(page)).split("\n")[1])
    .toBe("    return a + b");
});

test("shows the syntax error count and clears it after the fix", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(page, "function add(a, b) {\n  return a + b;\n");
  const errors = page.locator("[data-fork-code-syntax-errors]");
  await expect(errors).toHaveText(/^\d+ syntax errors?$/);
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await expect(errors).toHaveCount(0);
});

test("panel keys stay out of the editor, and Cmd+Enter still runs", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);
  await lab.openPanel();
  expect(await lab.panelOpen()).toBe(true);

  await page.evaluate(() => {
    (window as unknown as { gameKeys: string[] }).gameKeys = [];
  });
  await page.locator(editor).click();
  await page.keyboard.type("p");
  await page.keyboard.type("f");
  await page.keyboard.press("Escape");

  expect(await lab.panelOpen()).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { gameKeys: string[] }).gameKeys,
    ),
  ).toEqual([]);
  await expect(page.locator(editor)).not.toBeFocused();

  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await page.locator(editor).press("ControlOrMeta+Enter");
  await expect(page.locator("[data-fork-code-score]")).toHaveText(
    "Solved. 100 points.",
  );
});

test("code drills reload when the tab becomes active", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  const lab = labOf(page);
  await expect(page.locator(table)).toContainText("Add two numbers");

  // Code typed while parked must survive the reload.
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await lab.setActive(true);
  await expect.poll(() => lab.loads()).toBe(1);

  await lab.setActive(false);
  await lab.setDojoTitle("Add two numbers, from Dojo");
  await lab.setActive(true);
  await expect.poll(() => lab.loads()).toBe(2);
  await expect(page.locator(table)).toContainText("Add two numbers, from Dojo");
  expect(await codeText(page)).toContain("return a + b;");
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
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
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
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-fork-code-output]")).toContainText(
    "Earlier output was cut; this is the last 64 KB.",
  );
});

test("a long error keeps the message line above Node's tail", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);

  const stderr = [
    "/tmp/monocode-code-run-1234/main.js:3",
    "  return a + b;",
    "         ^",
    "",
    "SyntaxError: Unexpected token ')'",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `    at frame${index} (node:internal/modules/cjs/loader:${10 + index}:1)`,
    ),
  ].join("\n");
  await lab.setRunResult({ stdout: "", stderr, exitCode: 1 });

  await setCode(
    page,
    "function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2);\n",
  );
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.locator("[data-fork-code-errors]")).toContainText(
    "SyntaxError: Unexpected token ')'",
  );
  await expect(page.locator("[data-fork-code-error-summary]")).toContainText(
    "SyntaxError: Unexpected token ')'",
  );
  // The old tail-only view showed just the last six internal frames.
  await expect(page.locator("[data-fork-code-errors]")).toContainText("at frame0");
});

test("the console keeps output past 2000 characters", async ({ page }) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);

  await lab.setRunResult({ stdout: `${"a".repeat(2500)}THE-END` });
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await page.getByRole("button", { name: "Run" }).click();

  const output = page.locator("[data-fork-code-output]");
  await expect(output).toContainText("THE-END");
  expect(
    await output.evaluate((element) => element.textContent?.length ?? 0),
  ).toBeGreaterThan(2000);
});

test("clicking your code:N moves the editor's cursor to line N", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html?lab=1");
  await expect(page.locator(table)).toBeVisible();
  const lab = labOf(page);
  await lab.setActive(true);

  const stderr = [
    "/tmp/monocode-code-run-1234/main.js:2",
    "  return a + b;",
    "         ^",
    "",
    "ReferenceError: missing is not defined",
    "    at f (/tmp/monocode-code-run-1234/main.js:2:15)",
    "    at node:internal/main/run_main_module:33:47",
  ].join("\n");
  await lab.setRunResult({ stdout: "", stderr, exitCode: 1 });

  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-fork-code-errors]")).toBeVisible();

  await page
    .locator('[data-fork-code-errors] [data-fork-code-goto="2"]')
    .first()
    .click();
  await expect(page.locator(editor)).toHaveAttribute(
    "data-fork-code-cursor-line",
    "2",
  );
  await expect(page.locator(editor)).toBeFocused();
  await expect(page.locator(".cm-drill-error-line")).toHaveCount(1);

  await page.keyboard.type("x");
  await expect(page.locator(".cm-drill-error-line")).toHaveCount(0);
});

test("a misspelled variable is flagged and the quick fix clears it", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(
    page,
    "function add(a, b) {\n  const total = a + b;\n  return totl;\n}\n",
  );

  const count = page.locator("[data-fork-code-name-warnings]");
  await expect(count).toHaveText("1 name to check");
  const warning = page.locator(".cm-lintRange-warning").first();
  await expect(warning).toBeVisible();
  await expect(warning).toHaveCSS("text-decoration-color", "rgb(245, 158, 11)");

  await warning.hover();
  await page.getByRole("button", { name: "Change to total" }).click();
  await expect(count).toHaveCount(0);
  expect(await codeText(page)).toContain("return total;");
});

test("renaming a drill's function warns that the tests call it", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(page, "function Add(a, b) {\n  return a + b;\n}\n");

  await expect(page.locator("[data-fork-code-name-warnings]")).toHaveText(
    "1 name to check",
  );
  await page.locator(".cm-lintRange-warning").first().hover();
  const tooltip = page.locator(".cm-tooltip-lint");
  await expect(tooltip).toContainText(
    "The tests call `add`, but your code doesn't define it",
  );
  await expect(tooltip).toContainText("Did you mean `Add`?");
});

test("a correct solution has no name warnings and still passes", async ({
  page,
}) => {
  await page.goto("/tests/browser/code-drills.html");
  await expect(page.locator(table)).toBeVisible();
  await setCode(page, "function add(a, b) {\n  return a + b;\n}\n");
  await page.waitForTimeout(1000);

  await expect(page.locator("[data-fork-code-name-warnings]")).toHaveCount(0);
  await expect(page.locator(".cm-lintRange-warning")).toHaveCount(0);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-fork-code-score]")).toHaveText(
    "Solved. 100 points.",
  );
});
