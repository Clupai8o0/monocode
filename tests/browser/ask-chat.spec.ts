import { expect, test, type Locator, type Page } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const button = (page: Page) =>
  page.getByRole("button", { name: "Add to chat" });
const composer = (page: Page) => page.getByLabel("Composer");

/** A real mouse drag across a target, the way someone selects text. */
async function drag(page: Page, from: Locator, to: Locator = from) {
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    (start.x + end.x + end.width) / 2,
    (start.y + end.y) / 2 + end.height / 2,
    { steps: 4 },
  );
  await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
}

async function open(page: Page, view: string, theme: string, query = "") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(
    `/tests/browser/ask-chat.html?view=${view}&theme=${theme}${query}`,
  );
}

type Case = {
  view: string;
  select: (page: Page) => Promise<void>;
  expected: string;
};

const CASES: Case[] = [
  {
    view: "pdf",
    select: async (page) => {
      const text = page.locator(".textLayer span", { hasText: "Page one" });
      await text.waitFor();
      await drag(page, text);
    },
    expected: "report.pdf p. 1:\n\n> Page one",
  },
  {
    view: "office",
    select: async (page) => {
      const text = page.locator(".textLayer span", { hasText: "Page one" });
      await text.waitFor();
      await drag(page, text);
    },
    expected: "deck.pptx p. 1:\n\n> Page one",
  },
  {
    view: "latex",
    select: async (page) => {
      const text = page.locator(".textLayer span", { hasText: "Page one" });
      await text.waitFor();
      await drag(page, text);
    },
    expected: "main.tex PDF p. 1:\n\n> Page one",
  },
  {
    view: "xlsx",
    select: async (page) => {
      await page.getByRole("cell", { name: "410" }).waitFor();
      await drag(
        page,
        page.getByRole("cell", { name: "410" }),
        page.getByRole("cell", { name: "640" }),
      );
    },
    expected: "data.xlsx Budget!B3:C4:\n\n> 410\t380\n> 120\t640",
  },
  {
    view: "csv",
    select: async (page) => {
      await page.getByRole("cell", { name: "410" }).waitFor();
      await drag(
        page,
        page.getByRole("cell", { name: "410" }),
        page.getByRole("cell", { name: "640" }),
      );
    },
    expected: "data.csv B3:C4:\n\n> 410\t380\n> 120\t640",
  },
  {
    view: "notebook",
    select: async (page) => {
      const text = page.locator("p", {
        hasText: "A first look at the numbers.",
      });
      await text.waitFor();
      await drag(page, text);
    },
    expected: "analysis.ipynb cell 1:\n\n> A first look at the numbers.",
  },
  {
    view: "markdown",
    select: async (page) => {
      const text = page.locator("p", { hasText: "Run the installer once." });
      await text.waitFor();
      await drag(page, text);
    },
    expected: "docs/guide.md § Install:\n\n> Run the installer once.",
  },
  {
    view: "plan",
    select: async (page) => {
      const text = page.locator("p", { hasText: "Flip the flag at noon." });
      await text.waitFor();
      await drag(page, text);
    },
    expected: 'Plan "Rollout" § Steps:\n\n> Flip the flag at noon.',
  },
  {
    view: "diff",
    select: async (page) => {
      const row = page
        .locator("[data-diff-line]")
        .filter({ hasText: "new wording here" })
        .locator("[data-diff-code]");
      await row.waitFor();
      await drag(page, row);
    },
    expected: "src/app.ts:2:\n\n> new wording here",
  },
  {
    view: "html",
    select: async (page) => {
      const frame = page.locator("iframe");
      await frame.waitFor();
      const copy = page.frameLocator("iframe").locator("#copy");
      await copy.waitFor();
      // Inside a frame the box is still in page coordinates.
      await page.mouse.move(
        (await copy.boundingBox())!.x + 1,
        (await copy.boundingBox())!.y + 8,
      );
      await page.mouse.down();
      await page.mouse.move(
        (await copy.boundingBox())!.x + 200,
        (await copy.boundingBox())!.y + 8,
        { steps: 6 },
      );
      await page.mouse.up();
    },
    expected: "design.html:\n\n> Ship it on Friday.",
  },
  {
    view: "terminal",
    select: async (page) => {
      const screen = page.locator(".xterm-screen");
      await expect(page.locator(".xterm-rows")).toContainText("cargo test");
      const box = (await screen.boundingBox())!;
      await page.mouse.move(box.x + 1, box.y + 7);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 7, { steps: 6 });
      await page.mouse.up();
    },
    expected: "Terminal output:\n\n> cargo test",
  },
];

for (const theme of ["dark", "light"] as const) {
  for (const { view, select, expected } of CASES) {
    test(`${view} sends its quote and reference, ${theme}`, async ({
      page,
    }, testInfo) => {
      const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
      await open(page, view, theme);
      // A view can redraw once as its first layout settles, taking a selection
      // made during it along; the selection is what is under test, so retry.
      await expect(async () => {
        await page.evaluate(() => getSelection()?.removeAllRanges());
        await select(page);
        await expect(button(page)).toHaveCount(1, { timeout: 1000 });
      }).toPass({ timeout: 15000 });
      await page.screenshot({ path: `${dir}/${view}-${theme}.png` });
      await button(page).click();
      const value = await composer(page).inputValue();
      if (view === "terminal") {
        // How much of the line a drag covers depends on the font's width.
        expect(value.startsWith(expected)).toBe(true);
      } else {
        expect(value.trim()).toBe(expected);
      }
      await expect(button(page)).toHaveCount(0);
    });
  }
}

test("a selection across PDF pages names both", async ({ page }) => {
  await open(page, "pdf", "dark");
  const one = page.locator(".textLayer span", { hasText: "Page one" });
  const two = page.locator(".textLayer span", { hasText: "Page two" });
  await one.waitFor();
  await two.waitFor();
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".textLayer span")];
    const range = document.createRange();
    range.setStartBefore(spans[0]);
    range.setEndAfter(spans[spans.length - 1]);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await button(page).click();
  const value = await composer(page).inputValue();
  expect(value.startsWith("report.pdf pp. 1-2:")).toBe(true);
  expect(value).toContain("> Page one");
  expect(value).toContain("Page two");
});

test("words inside one cell go as they are", async ({ page }) => {
  await open(page, "csv", "dark");
  const cell = page.getByRole("cell", { name: "Travel" });
  await cell.waitFor();
  await cell.dblclick();
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toBe(
    "data.csv A4:\n\n> Travel",
  );
});

test("a table highlights the rectangle it will send", async ({ page }) => {
  await open(page, "csv", "dark");
  await page.getByRole("cell", { name: "410" }).waitFor();
  await drag(
    page,
    page.getByRole("cell", { name: "410" }),
    page.getByRole("cell", { name: "640" }),
  );
  await expect(button(page)).toBeVisible();
  await expect(page.locator("[data-ask-selected]")).toHaveText([
    "410",
    "380",
    "120",
    "640",
  ]);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-ask-selected]")).toHaveCount(0);
});

test("a sorted table names the rows, not a false range", async ({ page }) => {
  await open(page, "csv", "dark");
  await page.getByRole("button", { name: "Q2" }).click();
  await page.getByRole("cell", { name: "90", exact: true }).waitFor();
  // Rising Q2 shows rows 5, 3, 4, 2: the first two are not next to each other.
  await drag(
    page,
    page.getByRole("cell", { name: "90", exact: true }),
    page.getByRole("cell", { name: "420" }),
  );
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toBe(
    "data.csv D rows 3, 5:\n\n> 90\n> 420",
  );
});

test("across notebook cells names them all", async ({ page }) => {
  await open(page, "notebook", "dark");
  const first = page.locator("p", { hasText: "A first look at the numbers." });
  const last = page.locator("p", { hasText: "Closing remark." });
  await first.waitFor();
  await drag(page, first, last);
  await button(page).click();
  expect((await composer(page).inputValue()).split("\n")[0]).toBe(
    "analysis.ipynb cells 1-3:",
  );
});

test("the keyboard reaches the button: Tab then Enter", async ({ page }) => {
  await open(page, "markdown", "dark");
  const text = page.locator("p", { hasText: "Run the installer once." });
  await text.waitFor();
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("p")].find((entry) =>
      entry.textContent?.includes("Run the installer"),
    )!;
    getSelection()!.selectAllChildren(target);
  });
  await expect(button(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Enter");
  expect((await composer(page).inputValue()).trim()).toBe(
    "docs/guide.md § Install:\n\n> Run the installer once.",
  );
});

test("Tab inside the HTML page reaches the button too", async ({ page }) => {
  await open(page, "html", "dark");
  const copy = page.frameLocator("iframe").locator("#copy");
  await copy.waitFor();
  await copy.dblclick();
  await expect(button(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  // Escape hands the keyboard back to the page it came from.
  await page.keyboard.press("Escape");
  await expect(button(page)).toHaveCount(0);
  await expect(page.locator("iframe")).toBeFocused();
});

test("two HTML panes never leave two buttons or a stale quote", async ({
  page,
}) => {
  await open(page, "html,html2", "dark");
  const first = page.frameLocator("iframe").nth(0).locator("#copy");
  const second = page.frameLocator("iframe").nth(1).locator("#copy");
  await first.waitFor();
  await second.waitFor();
  await first.dblclick();
  await expect(button(page)).toHaveCount(1);
  await second.dblclick();
  await expect(button(page)).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Enter");
  const value = await composer(page).inputValue();
  expect(value.startsWith("design2.html:")).toBe(true);
});

test("a text pane's menu closes when an HTML pane takes over", async ({
  page,
}) => {
  await open(page, "markdown,html", "dark");
  const copy = page.frameLocator("iframe").locator("#copy");
  await copy.waitFor();
  await drag(page, page.locator("p", { hasText: "Run the installer once." }));
  await expect(button(page)).toHaveCount(1);
  await copy.dblclick();
  await expect(button(page)).toHaveCount(1);
  await button(page).click();
  expect((await composer(page).inputValue()).startsWith("design.html:")).toBe(
    true,
  );
});

test("Tab still works in an HTML page once its menu has gone", async ({
  page,
}) => {
  await open(page, "html", "dark");
  const copy = page.frameLocator("iframe").locator("#copy");
  await copy.waitFor();
  await copy.dblclick();
  await expect(button(page)).toBeVisible();
  // Dismissed from outside the page, so the page still has its selection.
  await page.getByRole("button", { name: "Reload HTML preview" }).hover();
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await expect(button(page)).toHaveCount(0);
  const prevented = await page.frames()[1].evaluate(() => {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("text lines up on a rotated PDF page", async ({ page }) => {
  await open(page, "rotated", "dark");
  const text = page.locator(".textLayer span", { hasText: "Page one" });
  await text.waitFor();
  await expect(page.locator(".textLayer").first()).toHaveAttribute(
    "data-main-rotation",
    "90",
  );
  const box = (await text.boundingBox())!;
  // Rotated a quarter turn, the word runs down the page.
  expect(box.height).toBeGreaterThan(box.width);
  const layer = (await page.locator(".textLayer").first().boundingBox())!;
  const pageBox = (await page
    .getByLabel("Page 1", { exact: true })
    .boundingBox())!;
  expect(Math.abs(layer.width - pageBox.width)).toBeLessThan(2);
  expect(Math.abs(layer.height - pageBox.height)).toBeLessThan(2);
  await expect(async () => {
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.mouse.move(box.x + box.width / 2, box.y + 1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 1, {
      steps: 6,
    });
    await page.mouse.up();
    await expect(button(page)).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await page.screenshot({
    path: `${process.env.LAB_SHOTS ?? "test-results"}/pdf-rotated.png`,
  });
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toBe(
    "rotated.pdf p. 1:\n\n> Page one",
  );
});

test("Escape dismisses and clears the selection", async ({ page }) => {
  await open(page, "markdown", "dark");
  const text = page.locator("p", { hasText: "Run the installer once." });
  await text.waitFor();
  await drag(page, text);
  await expect(button(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button(page)).toHaveCount(0);
  expect(await page.evaluate(() => getSelection()?.isCollapsed)).toBe(true);
});

test("split panes: only the pane with the selection answers", async ({
  page,
}, testInfo) => {
  const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
  await open(page, "markdown,csv", "dark");
  const cell = page.getByRole("cell", { name: "Travel" });
  await cell.waitFor();
  await drag(page, page.locator("p", { hasText: "Run the installer once." }));
  await expect(button(page)).toHaveCount(1);
  await page.screenshot({ path: `${dir}/split-left.png` });
  await cell.dblclick();
  await expect(button(page)).toHaveCount(1);
  await page.screenshot({ path: `${dir}/split-right.png` });
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toBe(
    "data.csv A4:\n\n> Travel",
  );
});

test("no session open: the quote seeds the chat that opens", async ({
  page,
}) => {
  await open(page, "markdown", "dark", "&nosession=1");
  const text = page.locator("p", { hasText: "Run the installer once." });
  await text.waitFor();
  await drag(page, text);
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toBe(
    "docs/guide.md § Install:\n\n> Run the installer once.",
  );
});

test("the source view keeps the editor's own reference", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("monocode.fileViewMode", "source"),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(
    "/tests/browser/ask-chat.html?view=markdown&theme=dark&source=1",
  );
  await page
    .getByRole("tab", { name: /source|code/i })
    .first()
    .click()
    .catch(() => {});
  const line = page
    .locator(".cm-line")
    .filter({ hasText: "Run the installer" });
  await line.waitFor();
  await line.click({ clickCount: 3 });
  await button(page).click();
  expect((await composer(page).inputValue()).trim()).toMatch(
    /^`?@?\/?(repo\/)?docs\/guide\.md`? \(lines? 7(-\d+)?\)$/,
  );
});
