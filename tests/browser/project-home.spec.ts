import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`project home, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 1500 });
    await page.goto(`/tests/browser/project-home.html?theme=${theme}`);
    const home = page.locator('[data-fork-project-home="home"]');
    await expect(home.getByText("Now:")).toBeVisible();
    await expect(home.getByText("Phase 2 · Search").first()).toBeVisible();
    // A question and the person's checklist step wait; the step is over a day old.
    await expect(home.getByText("CRDT or last-write-wins for sync?")).toBeVisible();
    await expect(home.getByText("Run the kill test on your Android phone")).toBeVisible();
    await expect(home.getByText("1d", { exact: true })).toBeVisible();
    // Search and Daily writer are active; Sync and Rewards are up next; Mockups is done.
    await expect(home.locator('[data-phase="2"]')).toBeVisible();
    await expect(home.locator('[data-phase="1"]')).toBeVisible();
    await expect(home.getByRole("button", { name: "Start" })).toHaveCount(2);
    await expect(home.getByText("Mockups")).toBeVisible();
    // Chats not on a phase.
    await expect(home.getByText("Fix the CI cache")).toBeVisible();
    await page.screenshot({ path: `${dir}/home-${theme}.png`, fullPage: true });

    // Setting a status writes the plan and offers an undo.
    await home.locator('[data-phase="2"]').getByRole("button", { name: /In progress/ }).click();
    await page.getByRole("menuitemradio", { name: "Built" }).click();
    await expect(page.getByRole("status")).toContainText("Phase 2 set to Built");
    await expect(home.locator('[data-phase="2"]').getByRole("button", { name: /Built/ })).toBeVisible();

    // The status menu works from the keyboard and gives focus back.
    const status = home.locator('[data-phase="1"]').getByRole("button", { name: /Built/ });
    await status.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Status of phase 1" });
    await expect(menu.getByRole("menuitemradio", { name: "Built" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitemradio").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(status).toBeFocused();

    // Putting a loose chat on a phase moves it into that phase's card.
    await home.getByRole("button", { name: /Fix the CI cache/ }).click();
    await page.getByRole("menuitemradio", { name: /Search/ }).click();
    await expect(home.locator('[data-phase="2"]').getByText("Fix the CI cache")).toBeVisible();

    // Start on an upcoming phase launches a chat and marks it in progress.
    await home.locator('[data-phase="4"]').getByRole("button", { name: "Start" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-launched", /\/p\/yap \| Phase 4 Rewards \| reveal/);
  });

  test(`all projects, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.goto(`/tests/browser/project-home.html?view=all&theme=${theme}`);
    const all = page.locator('[data-fork-project-home="all"]');
    await expect(all.getByText("What needs you across 3 projects")).toBeVisible();
    await expect(all.getByText("2 projects have no roadmap status")).toBeVisible();
    await all.getByRole("button", { name: "Ask them to fill it" }).click();
    await expect(all.getByText("Fill status in docs/plan.md")).toBeVisible();
    await page.screenshot({ path: `${dir}/all-${theme}.png`, fullPage: true });
    await all.getByRole("checkbox").first().uncheck();
    await all.getByRole("button", { name: "Start 1 chat" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-launched", "/p/new | Draft a roadmap | quiet");
    await expect(all.getByText("Started 1 chat")).toBeVisible();
  });

  test(`no plan, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/tests/browser/project-home.html?view=noplan&theme=${theme}`);
    const home = page.locator('[data-fork-project-home="home"]');
    await expect(home.getByText("No roadmap yet")).toBeVisible();
    await expect(home.getByText("Set up the repo")).toBeVisible();
    await page.screenshot({ path: `${dir}/noplan-${theme}.png`, fullPage: true });
    await home.getByRole("button", { name: "Draft a plan" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-launched", "/p/new | Draft a roadmap | reveal");
  });
}
