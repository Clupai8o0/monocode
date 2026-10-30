import { expect, test } from "@playwright/test";

test("a session named in a reply opens from its name", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/workspace-performance.html?projects&machines&sessionRefs");
  await page.getByRole("button", { name: /^Prepare the handoff/ }).first().click();
  const ref = (word: string) => page.locator(`[data-fork-session-ref="${word}"]:visible`);

  await expect(ref("monocode-effort")).toHaveText("monocode-effort");
  await expect(ref("clupai-32")).toHaveCount(1);
  await expect(page.locator('[data-fork-session-ref="real-time"]')).toHaveCount(0);
  await expect(page.getByText("real-time mention stays plain").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("session-refs.png") });

  // On another machine: reads it in the viewer.
  await ref("monocode-effort").click();
  await expect(page.getByText("Live turn from lab-run")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Live turn from lab-run")).toHaveCount(0);

  // Started by this app: goes to the session itself.
  await ref("monocode-own").click();
  await expect(page.getByText("Which sample should I check next?").first()).toBeVisible();
});
