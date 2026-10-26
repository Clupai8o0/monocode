import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1300, height: 900 } });

test("keeps notifications and workspace controls in the window's top-left toolbar", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/workspace-performance.html?projects");
  const toolbar = page.locator("[data-inset-title-nav]");
  const sidebar = page.locator(".inset-sidebar");
  const bell = toolbar.getByRole("button", { name: /^Notifications/ });
  const toggle = toolbar.getByRole("button", { name: /^Toggle Sidebar/ });
  const worktrees = toolbar.getByRole("button", { name: "Worktrees", exact: true });
  const settings = toolbar.getByRole("button", { name: /^Settings \(/ });
  await expect(sidebar.locator("[data-project-path]")).toHaveCount(16);
  await expect(sidebar.getByRole("button", { name: "monocode menu", exact: true })).toHaveCount(0);
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(worktrees).toHaveAttribute("title", "Worktrees · mine");
  await expect(page.locator("[data-fork-notifications]")).toHaveCount(1);
  await expect(bell).toHaveAttribute("aria-label", /^Notifications, \d+ unread$/);
  await expect(page.locator(".approval-toast")).toHaveCount(0);

  const toggleBox = (await toggle.boundingBox())!;
  const bellBox = (await bell.boundingBox())!;
  expect(bellBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width);
  expect(bellBox.x).toBeLessThan(toggleBox.x + toggleBox.width + 8);
  expect(Math.abs(bellBox.y + bellBox.height / 2 - toggleBox.y - toggleBox.height / 2)).toBeLessThan(1);
  expect(bellBox.x).toBeLessThan(170);
  expect(bellBox.y).toBeLessThan(40);
  await page.screenshot({ path: testInfo.outputPath("projects-toolbar.png") });

  await bell.click();
  await expect(page.getByRole("dialog", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.locator("[data-fork-notification-row]")).toHaveCount(4);
  await expect(page.locator(".approval-toast")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("top-left-notifications.png") });
  await page.keyboard.press("Escape");
  await worktrees.click();
  const picker = page.getByRole("dialog", { name: "Working copies", exact: true });
  await expect(picker.getByRole("option", { selected: true })).toContainText("mine");
  await expect(picker.getByRole("button", { name: "Manage worktrees", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("top-left-worktrees.png") });
  await page.keyboard.press("Escape");

  // Settings act on the row that opened them without changing selection.
  await sidebar.getByRole("button", { name: "Project settings for morgue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Group name", exact: true })).toHaveValue("morgue");
  await expect(sidebar.locator('[data-project-path="/fixture/projects/monocode"] [aria-current="page"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await sidebar.locator('[data-project-path="/fixture/projects/morgue"] > button').first().click();
  await expect(sidebar.locator('[data-project-path="/fixture/projects/morgue"] [aria-current="page"]')).toHaveCount(1);

  await toggle.click();
  await page.mouse.move(800, 400);
  await expect(sidebar).toHaveCount(0);
  await bell.click();
  await expect(page.getByRole("dialog", { name: "Notifications", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await worktrees.click();
  await picker.getByRole("button", { name: "Manage worktrees", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search working copies", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Worktrees", exact: true })).toHaveAttribute("aria-current", "true");
  await settings.click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
});
