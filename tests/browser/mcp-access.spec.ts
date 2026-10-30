import { expect, test } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

for (const theme of ["dark", "light"] as const) {
  test(`mcp access, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 780, height: 1100 });

    await page.goto(`/tests/browser/mcp-access.html?theme=${theme}&empty`);
    await page.screenshot({ path: `${dir}/empty-${theme}.png` });

    await page.goto(`/tests/browser/mcp-access.html?theme=${theme}`);
    await page.getByRole("button", { name: "Add an agent" }).click();
    // Read only is the starting choice; more has to be chosen.
    await expect(page.getByRole("radio", { name: /^Read only/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const create = page.getByRole("button", { name: "Create token" });
    await expect(create).toBeDisabled();
    await page.getByLabel("Name").fill("grok");
    await expect(create).toBeDisabled();
    await page.getByRole("button", { name: "monocode", exact: true }).click();
    await expect(create).toBeEnabled();
    await page.screenshot({ path: `${dir}/add-${theme}.png` });
    await create.click();
    await expect(page.getByText("Add this to grok's config")).toBeVisible();
    await expect(page.getByText("[mcp_servers.monocode]")).toBeVisible();
    await page.screenshot({ path: `${dir}/created-${theme}.png` });
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect(page.getByRole("button", { name: "Confirm remove" })).toBeVisible();
    await page.screenshot({ path: `${dir}/clients-log-${theme}.png` });
  });
}
