import { expect, test } from "@playwright/test";

test("picks options from a reply into the real composer", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&taskPicks");
  const ship = page.locator('input[data-task-label="Ship it"]:visible').first();
  const hold = page.locator('input[data-task-label="Hold it"]:visible').first();
  await expect(ship).toBeEnabled();
  const composer = page.locator("textarea:visible").first();
  await composer.fill("My note");

  await ship.click();
  await expect(composer).toHaveValue("My note\nShip it\n");
  await expect(composer).toBeFocused();
  await page.getByText("Hold it", { exact: true }).first().click();
  await expect(hold).toBeChecked();
  await expect(composer).toHaveValue("My note\nShip it\nHold it\n");
  await page.screenshot({ path: testInfo.outputPath("picked.png") });

  await ship.click();
  await expect(ship).not.toBeChecked();
  await expect(composer).toHaveValue("My note\nHold it\n");

  // Picking only fills the box: Nothing was sent, and it stays until sent.
  await expect(page.locator('[data-chat-message-role="user"]', { hasText: "Hold it" })).toHaveCount(0);
});

test("keeps picks across a reload and between windows", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/task-picks.html");

  const apply = page.locator('input[data-task-label^="Apply"]');
  const hold = page.locator('input[data-task-label^="Hold"]');
  await apply.click();
  await page.getByText("Hold: if A fails").click();
  await expect(apply).toBeChecked();
  await expect(hold).toBeChecked();

  await page.reload();
  await expect(apply).toBeChecked();
  await expect(hold).toBeChecked();

  // A second window sees a tick at once, and its own save keeps the first's.
  const other = await page.context().newPage();
  await other.goto("/tests/browser/task-picks.html");
  const otherHold = other.locator('input[data-task-label^="Hold"]');
  await expect(otherHold).toBeChecked();
  await hold.click();
  await expect(otherHold).not.toBeChecked();
  await other.locator('input[data-task-label^="Apply"]').click();
  await expect(apply).not.toBeChecked();
  await expect(hold).not.toBeChecked();
});
