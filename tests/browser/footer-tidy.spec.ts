import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1300, height: 900 } });

type Fixture = {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

async function open(page: import("@playwright/test").Page) {
  await page.addInitScript(() => localStorage.setItem("monocode.insetLayout", "1"));
  await page.goto("/tests/browser/workspace-performance.html");
  await expect(page.locator(".inset-shell")).toBeVisible({ timeout: 15_000 });
}

test("Ultrareview sits in the composer and its popover isn't clipped", async ({ page }, testInfo) => {
  await open(page);
  const button = page.locator("[data-composer] [data-fork-ultrareview]").first();
  await expect(button).toBeVisible();
  await expect(page.locator("footer [data-fork-ultrareview]")).toHaveCount(0);
  await button.click();
  const input = page.getByLabel("PR number or base branch");
  await expect(input).toBeVisible();
  await input.fill("123");
  await expect(input).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("ultrareview.png") });
  const panel = (await input.boundingBox())!;
  const anchor = (await button.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(anchor.y);
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});

test("high usage moves onto the Memory chip, which keeps its width", async ({ page }, testInfo) => {
  await open(page);
  const chip = page.locator("[data-fork-memory]");
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture & { high: boolean };
    fixture.high = false;
    const base = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "fork_memory_report") {
        return { pressure: "normal", totalBytes: 16e9, availableBytes: 8e9, sessions: [] };
      }
      if (command === "resource_usage") {
        return { cpuPercent: fixture.high ? 95 : 5, memoryPressure: 0 };
      }
      if (command === "resource_processes") {
        return [];
      }
      return base(command, args);
    };
  });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  const before = (await chip.boundingBox())!.width;
  await page.evaluate(() => {
    (window as unknown as { high: boolean }).high = true;
  });
  await expect(chip).toHaveAttribute("title", /High CPU usage/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "High resource usage" })).toHaveCount(0);
  await expect(chip.locator(".bg-amber-400")).toHaveCount(1);
  expect((await chip.boundingBox())!.width).toBe(before);
  await chip.click();
  const row = page.locator("[data-fork-review-work]");
  await expect(row).toHaveText("High CPU usage · Review running work");
  await page.screenshot({ path: testInfo.outputPath("memory-row.png") });
  await row.click();
  await expect(page.getByRole("dialog", { name: "Running work" })).toBeVisible();
});

test("the red count explains itself and opens those problems", async ({ page }, testInfo) => {
  // The log polls once a minute while its window is closed.
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as unknown as { problemAt: number }).problemAt = Date.now() - 60_000;
  });
  await open(page);
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture & { problemAt: number };
    const base = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "fork_message_log") {
        const at = fixture.problemAt;
        return {
          version: 1,
          machine: "mac",
          epoch: "e",
          cursor: 1,
          full: true,
          windowHours: 24,
          scannedAt: Date.now(),
          sessions: [],
          proxies: [],
          events: [
            {
              kind: "send",
              id: "s:1",
              rev: 1,
              at,
              updatedAt: at,
              sessionId: "abcdefgh",
              account: "main",
              to: "ghost",
              toAddress: "name",
              preview: "hello",
              key: "hello",
              status: "failed",
              error: "Refused: that session is not accepting messages",
            },
          ],
        };
      }
      return base(command, args);
    };
  });
  const button = page.locator("[data-fork-messages]");
  await expect(button.locator("[data-fork-messages-problems]")).toHaveText("1", { timeout: 90_000 });
  await button.click();
  const row = page.locator("[data-fork-messages-problems-row]");
  await expect(row).toHaveText("1 went wrong in the last hour");
  await expect(page.getByText(/\d+ in$/)).toHaveCount(0);
  await expect(page.getByText("No session has messaged")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("messages-popover.png") });
  await row.click();
  await expect(page.getByRole("button", { name: "Problems only" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Refused: that session is not accepting messages").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("messages-problems.png") });
});
