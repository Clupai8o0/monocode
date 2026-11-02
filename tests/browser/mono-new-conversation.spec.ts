import { expect, test, type Locator } from "@playwright/test";

async function expectApart(first: Locator, second: Locator) {
  const a = (await first.boundingBox())!;
  const b = (await second.boundingBox())!;
  const apart =
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y;
  expect(apart, `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`).toBe(true);
}

test("a Mono's buttons clear the checklist, and a new conversation keeps the old one", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&safeClose&monoView");
  await page.locator('[title^="Kickoff"]:not([data-title-tab])').first().click();

  const gear = page.getByRole("button", { name: "Kickoff settings" });
  const fresh = page.getByRole("button", { name: "New conversation with Kickoff" });
  await expect(gear).toBeVisible();

  // Folded and open, the checklist sits below the buttons floating over the pane.
  const rail = page.locator('[data-fork-checklist="collapsed"]:visible');
  await expect(rail).toBeVisible();
  await expectApart(gear, rail);
  await expectApart(fresh, rail);
  await page.screenshot({ path: testInfo.outputPath("mono-rail.png") });
  await rail.click();
  const hide = page.getByRole("button", { name: "Hide checklist" });
  await expect(hide).toBeVisible();
  await expectApart(gear, hide);
  await page.screenshot({ path: testInfo.outputPath("mono-panel.png") });

  // A new conversation is empty and the old one is listed under Archived.
  const view = page.locator("[data-mono-view]:visible");
  await expect(view).toContainText("This preview uses the real MonoCode app");
  await fresh.click();
  await expect(view).not.toContainText("This preview uses the real MonoCode app");
  await expect(page.locator('[data-fork-checklist]:visible')).toHaveCount(0);
  await expect(page.locator("[data-fork-archived]")).toContainText("Review the sidebar interactions");
  await page.screenshot({ path: testInfo.outputPath("mono-fresh.png") });

  // Its settings list the old chat wherever it was filed, and open it.
  await gear.click();
  const past = page.locator("[data-fork-mono-past]");
  await expect(past).toContainText("Review the sidebar interactions");
  await page.screenshot({ path: testInfo.outputPath("mono-past.png") });
  await past.click();
  await expect(page.locator("[data-mono-view]:visible")).toHaveCount(0);
  await expect(page.getByText("This preview uses the real MonoCode app").first()).toBeVisible();
});

test("a ticked option stays in its own conversation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&safeClose&monoView");

  // A project session stays mounted, and active, under the Mono's view.
  await page.getByRole("button", { name: /^Prepare the handoff/ }).first().click();
  await page.locator('[title^="Kickoff"]:not([data-title-tab])').first().click();
  const view = page.locator("[data-mono-view]:visible");
  await page.evaluate((event) => {
    window.addEventListener(event, (e) => {
      (window as unknown as { tickedFor?: string }).tickedFor = (e as CustomEvent<{ sessionId?: string }>).detail.sessionId;
    });
  }, "monocode:add-to-chat");
  await view.getByRole("checkbox", { name: "Fits the chat" }).click();
  await expect(view.locator("textarea")).toHaveValue(/Fits the chat/);
  // Named for its own chat, so it can't land in a split pane that has focus.
  expect(await page.evaluate(() => (window as unknown as { tickedFor?: string }).tickedFor)).toBe("workspace-session-0");

  // A workspace chat renders through the transcript pool: it names itself too.
  await page.getByRole("button", { name: /^Prepare the handoff/ }).first().click();
  await page.getByRole("checkbox", { name: "Pooled option" }).click();
  const pooledFor = await page.evaluate(() => (window as unknown as { tickedFor?: string }).tickedFor);
  expect(pooledFor).toMatch(/^workspace-session-/);
  expect(pooledFor).not.toBe("workspace-session-0");
  await expect(page.locator("textarea:visible").first()).toHaveValue(/Pooled option/);
  await page.getByRole("checkbox", { name: "Pooled option" }).click();
  await expect(page.locator("textarea:visible").first()).toHaveValue("");
  await page.locator('[title^="Kickoff"]:not([data-title-tab])').first().click();

  // Back in the project, its composer never got the Mono's option.
  await page.getByRole("button", { name: /^Prepare the handoff/ }).first().click();
  await expect(page.locator("[data-mono-view]:visible")).toHaveCount(0);
  await expect(page.locator("textarea:visible").first()).toHaveValue("");

  // A second click takes the line back out of the Mono's composer alone.
  await page.locator('[title^="Kickoff"]:not([data-title-tab])').first().click();
  await view.getByRole("checkbox", { name: "Fits the chat" }).click();
  await expect(view.locator("textarea")).toHaveValue("");
});
