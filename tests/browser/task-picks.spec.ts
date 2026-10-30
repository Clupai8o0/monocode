import { expect, test } from "@playwright/test";

test("ticks the boxes in a reply and adds them to the message", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/task-picks.html");

  const apply = page.locator('input[data-task-label^="Apply"]');
  const hold = page.locator('input[data-task-label^="Hold"]');
  await expect(apply).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("unticked.png") });

  await apply.click();
  await expect(apply).toBeChecked();
  await page.getByText("Hold: if A fails").click();
  await expect(hold).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("ticked.png") });

  await page.locator("[data-task-picks-add]").click();
  await expect(page.locator("[data-fixture-composer]")).toContainText(
    "Picked:\n- Apply at A's line",
  );
  await expect(page.locator("[data-task-picks-add]")).toHaveCount(0);

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
