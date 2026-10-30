import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`large paste, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 800, height: 500 });
    const shot = page.locator('[data-shot="composer"]');

    // What a paste this size does without the feature.
    await page.goto(`/tests/browser/large-paste.html?theme=${theme}&flood`);
    await shot.screenshot({ path: `${dir}/before-${theme}.png` });

    await page.goto(`/tests/browser/large-paste.html?theme=${theme}`);
    const field = page.locator("textarea");
    await field.evaluate((element: HTMLTextAreaElement) => {
      const text = Array.from(
        { length: 900 },
        (_, line) =>
          `Error: build failed at step ${line}: cannot resolve module './chunk-${line}.js'`,
      ).join("\n");
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const note = page.locator("[data-fork-large-paste]");
    await expect(note).toContainText("pasted as a file");
    await expect(note).toContainText("Error: build failed at step 0");
    await expect(field).toHaveValue("Why is the build failing? ");
    await shot.screenshot({ path: `${dir}/after-${theme}.png` });

    await page.getByRole("button", { name: "Paste as text instead" }).click();
    await expect(note).toHaveCount(0);
    await expect(field).toHaveValue(/^Why is the build failing\? Error: build failed/);
  });
}
