import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

test("sends only on the click, says what happened, and keeps the text if any failed", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/broadcast-bar.html");
  await page.locator("[data-fork-broadcast]").click();
  const bar = page.locator("[data-fork-broadcast-bar]");
  await expect(bar).toBeVisible();
  const send = bar.getByRole("button", { name: /^Send to \d+ session/ });

  await expect(send).toHaveText("Send to 3 sessions");
  await expect(send).toBeDisabled();
  await expect(bar).toContainText("Left out: 1 orchestration session, 1 holds a draft, 1 not started");
  await expect(bar.locator('[data-fork-broadcast-session="busy"]')).toContainText("after this turn");
  await expect(bar.locator('[data-fork-broadcast-session="other"]')).toHaveCount(0);

  await bar.getByRole("radio", { name: "One project" }).click();
  await bar.getByLabel("Project").selectOption("/other");
  await expect(send).toHaveText("Send to 1 session");
  await expect(bar.locator('[data-fork-broadcast-session="other"]')).toBeVisible();
  await expect(bar.locator('[data-fork-broadcast-session="idle"]')).toHaveCount(0);

  await bar.getByRole("radio", { name: "All projects" }).click();
  await expect(send).toHaveText("Send to 4 sessions");
  await bar.locator('[data-fork-broadcast-session="other"] input').uncheck();
  await expect(send).toHaveText("Send to 3 sessions");

  const message = bar.getByLabel("Message", { exact: true });
  await message.fill("Run the tests");
  await message.press("Enter");
  await message.press("Control+Enter");
  expect(await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("bar.png") });

  await message.fill("Run the tests");
  await send.click();
  expect(await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent)).toEqual([
    { id: "idle", text: "Run the tests" },
    { id: "busy", text: "Run the tests" },
  ]);
  await expect(bar.locator('[data-fork-broadcast-session="idle"]')).toContainText("Sent");
  await expect(bar.locator('[data-fork-broadcast-session="busy"]')).toContainText("Queued for after this turn");
  await expect(bar.locator('[data-fork-broadcast-session="refuses"]')).toContainText("It did not accept the message");
  await expect(message).toHaveValue("Run the tests");
  await expect(bar.getByRole("alert")).toHaveText("1 failed. Your message is still here.");
  await page.screenshot({ path: testInfo.outputPath("result.png") });

  // Trying again goes only to the one that failed.
  await expect(send).toHaveText("Send to 1 session");
  await send.click();
  const sent = await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent);
  expect(sent).toHaveLength(2);

  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(page.locator("[data-fork-broadcast]")).toBeFocused();
});
