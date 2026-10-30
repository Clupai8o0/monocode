import { expect, test, type Page } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

async function open(page: Page, query: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/tests/browser/lab-button.html?${query}`);
  await page.locator("[data-fork-lab]").click();
  await expect(page.locator('[aria-label="Home lab"]').last()).toBeVisible();
}

async function shoot(page: Page, dir: string, name: string) {
  const box = (await page.locator('[aria-label="Home lab"]').last().boundingBox())!;
  await page.screenshot({
    path: `${dir}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - 16),
      y: Math.max(0, box.y - 16),
      width: box.width + 32,
      height: Math.min(800 - box.y + 16, 460),
    },
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`health: all well, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await open(page, `health=ok&theme=${theme}`);
    const section = page.locator("[data-fork-lab-health]");
    await expect(section.getByText("Memory", { exact: true })).toBeVisible();
    await expect(section.getByText("9.6 GB free")).toBeVisible();
    await expect(section.getByRole("img", { name: /CPU over the last 10 minutes, now 31%/ })).toBeVisible();
    await expect(section.getByRole("listitem")).toHaveCount(2);
    const table = section.getByRole("listitem").filter({ hasText: "monocode-table" });
    await expect(table).toContainText("38 tok/s");
    await expect(table).toContainText("4 s ago");
    await expect(section.getByRole("listitem").filter({ hasText: "t3-phases" })).toContainText("running a tool");
    await expect(section.getByText("1 idle.")).toBeVisible();
    await expect(section.getByText(/Round trip \d+ ms/)).toBeVisible();
    await expect(section.getByText(/Agents 10 of 10 · 1 waiting/)).toBeVisible();
    await expect(section.getByRole("alert")).toHaveCount(0);
    await shoot(page, dir, `lab-health-ok-${theme}`);
  });

  test(`health: lagging sessions, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await open(page, `health=lag&theme=${theme}`);
    const rows = page.locator("[data-fork-lab-health]").getByRole("listitem");
    await expect(rows.first()).toContainText("monocode-crossmachine");
    await expect(rows.first()).toContainText("no response");
    await expect(rows.nth(1)).toContainText("monocode-footer-tidy");
    await expect(rows.nth(1)).toContainText("slow");
    await shoot(page, dir, `lab-health-lag-${theme}`);
  });

  test(`health: machine strained, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await open(page, `health=strained&theme=${theme}`);
    const alert = page.locator("[data-fork-lab-health]").getByRole("alert");
    await expect(alert).toContainText("Machine strained");
    await expect(alert).toContainText("load is 26 on 20 cores");
    await expect(alert).toContainText("swap is climbing");
    await expect(alert).toContainText("running hot at 94°C");
    await shoot(page, dir, `lab-health-strained-${theme}`);
  });

  test(`health: host unreachable, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await open(page, `health=down&theme=${theme}`);
    const section = page.locator("[data-fork-lab-health]");
    await expect(section.getByText(/Can't reach vivobook/)).toBeVisible();
    await expect(section.getByText(/stopped updating/)).toBeVisible();
    await expect(section.getByRole("button", { name: "Try again" })).toBeVisible();
    await shoot(page, dir, `lab-health-down-${theme}`);
  });
}

test("a host that doesn't offer it shows no health section", async ({ page }) => {
  await open(page, "theme=dark");
  await expect(page.locator("[data-fork-lab-health]")).toHaveCount(0);
});

test("the popover polls every 5 s and has no rules or dividers", async ({ page }) => {
  await page.clock.install();
  await open(page, "health=ok&theme=dark");
  const section = page.locator("[data-fork-lab-health]");
  await expect(section.getByText("9.6 GB free")).toBeVisible();
  const asked = () =>
    page.evaluate(() => (window as unknown as { __healthAsks?: number }).__healthAsks ?? 0);
  const before = await asked();
  await page.clock.runFor(15_000);
  expect((await asked()) - before).toBeGreaterThanOrEqual(3);
  const borders = await section.evaluate((root) =>
    [root, ...root.querySelectorAll("*")].filter((el) => {
      const style = getComputedStyle(el);
      return ["Top", "Right", "Bottom", "Left"].some(
        (side) =>
          parseFloat(style[`border${side}Width` as "borderTopWidth"]) > 0 &&
          style[`border${side}Style` as "borderTopStyle"] !== "none",
      );
    }).length,
  );
  expect(borders).toBe(0);
});

test("the chip's dot shows lag and strain, names why, and keeps the chip's width", async ({ page }, testInfo) => {
  const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
  const chip = page.locator("[data-fork-lab]");
  const dot = page.locator("[data-fork-lab-dot]");
  const load = async (kind: string) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/tests/browser/lab-button.html?health=${kind}&theme=dark`);
    await expect(chip).toBeVisible();
  };

  await load("ok");
  await page.waitForTimeout(300);
  await expect(dot).toHaveAttribute("data-fork-lab-dot", "");
  await expect(dot).toHaveCSS("visibility", "hidden");
  const width = (await chip.boundingBox())!.width;
  await chip.screenshot({ path: `${dir}/lab-chip-health-ok.png` });

  await load("strained");
  await expect(dot).toHaveAttribute("data-fork-lab-dot", "amber");
  await expect(chip).toHaveAttribute("title", /The machine is strained: .*running hot at 94°C/);
  expect((await chip.boundingBox())!.width).toBe(width);
  await chip.screenshot({ path: `${dir}/lab-chip-health-amber.png` });

  await load("lag");
  await expect(dot).toHaveAttribute("data-fork-lab-dot", "red");
  await expect(chip).toHaveAttribute("title", /monocode-crossmachine: no response for 4 min\./);
  await expect(chip).toHaveAttribute("title", /monocode-footer-tidy: slow, 3 tok\/s\./);
  expect((await chip.boundingBox())!.width).toBe(width);
  await chip.screenshot({ path: `${dir}/lab-chip-health-red.png` });

  // An unreachable host's old numbers say nothing here.
  await load("down");
  await page.waitForTimeout(300);
  await expect(dot).toHaveAttribute("data-fork-lab-dot", "");
});

test("the closed chip keeps polling, every 30 s", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/browser/lab-button.html?health=ok&theme=dark");
  await expect(page.locator("[data-fork-lab]")).toBeVisible();
  const asked = () =>
    page.evaluate(() => (window as unknown as { __healthAsks?: number }).__healthAsks ?? 0);
  await page.clock.runFor(1000);
  const before = await asked();
  await page.clock.runFor(61_000);
  const after = await asked();
  expect(after - before).toBeGreaterThanOrEqual(2);
  expect(after - before).toBeLessThanOrEqual(3);
});
