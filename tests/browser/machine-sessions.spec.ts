import { expect, test } from "@playwright/test";

const openSession = (id: string) =>
  (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "fork_open_session", payload: id });

test("opening a session from another project moves the tab strip with it", async ({ page }) => {
  await page.goto("/tests/browser/workspace-performance.html?projects&machines");
  const strip = page.locator("[data-title-tab-strip]");
  await expect(strip).toContainText("Review the sidebar interactions");

  // A tab left open in morgue, then back to monocode with morgue's tab hidden.
  await page.evaluate(openSession, "workspace-session-4");
  await expect(page.locator("[data-title-tab-active]")).toHaveCount(1);
  await page.evaluate(openSession, "workspace-session-0");
  await expect(strip.locator('[data-title-tab-id]')).toHaveCount(3);

  // The notification click: this tab is open, in the other project.
  await page.evaluate(openSession, "workspace-session-4");
  await expect(strip.locator('[data-title-tab-id]')).toHaveCount(1);
  await expect(page.locator("[data-title-tab-active]")).toHaveCount(1);
  await expect(page.locator('[aria-current="page"]').first()).toContainText("morgue");
});

test("shows a connected machine's live sessions and the device on the composer", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/workspace-performance.html?projects&machines");
  const group = page.locator("[data-fork-machine-sessions]");
  await expect(group).toContainText("Vivobook");
  await expect(group).toContainText("1 running");
  const rows = group.locator("[data-fork-elsewhere-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("monocode-effort");

  await expect(page.locator("[data-composer-device]").first()).toContainText("This Mac");
  await page.screenshot({ path: testInfo.outputPath("machine-sessions.png") });

  await rows.first().click();
  await expect(page.locator("[data-fork-external-viewer]")).toContainText("Live turn from lab-run");
  await expect(page.locator("[data-fork-external-continue]")).toHaveCount(0);
});
