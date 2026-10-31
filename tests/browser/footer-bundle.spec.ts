import { expect, test, type Page } from "@playwright/test";

const CHIPS = ["[data-fork-messages]", "[data-fork-machines]", "[data-fork-more]"];
const ALL_ALERTS = "lab,stacks,critical,high,ring,messages,problems";

async function load(page: Page, query = "") {
  await page.goto(`/tests/browser/footer-bundle.html?${query}`);
  await expect(page.locator("[data-fork-machines]")).toBeVisible({ timeout: 15_000 });
}

const terminal = (page: Page) => page.getByRole("button", { name: /New Terminal/ });

/** Where everything on the right sits, once what's asked for has shown up. */
async function measure(page: Page) {
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
  return {
    terminalX: (await terminal(page).boundingBox())!.x,
    slot: await box("[data-fork-messages-slot]"),
    machines: await box("[data-fork-machines]"),
    more: await box("[data-fork-more]"),
  };
}

test("the right side is Messages, Machines, More, Terminal and nothing else", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page);
  const texts = await page
    .locator("footer > div:last-child button")
    .evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()));
  expect(texts).toEqual(["Messages", "Machines", "More", "Terminal"]);
  for (const gone of ["[data-fork-broadcast]", "[data-fork-games]", "[data-fork-ring]", "[data-fork-lab]", "[data-fork-stacks]", "[data-fork-memory]"]) {
    await expect(page.locator(gone)).toHaveCount(0);
  }
  await expect(page.locator("[data-fork-workspaces]")).toHaveCount(1);
});

for (const width of [1300, 900]) {
  test(`Terminal and the chips never move at ${width} wide, alerts on or off`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await load(page);
    await expect(page.locator("[data-fork-machines]")).toHaveAttribute("title", /Stacks/);
    const calm = await measure(page);
    const states: [string, (p: Page) => Promise<void>][] = [
      ["lab", (p) => expect(p.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "amber")],
      ["stacks", (p) => expect(p.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "amber")],
      ["memory", (p) => expect(p.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "amber")],
      ["critical", (p) => expect(p.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "red")],
      ["ring", (p) => expect(p.locator("[data-fork-more-dot]")).toHaveAttribute("data-fork-more-dot", "amber")],
      ["messages", (p) => expect(p.locator("[data-fork-messages]")).toContainText("99+")],
      ["problems", (p) => expect(p.locator("[data-fork-messages-problems]")).toHaveText("99+", { timeout: 15_000 })],
      [ALL_ALERTS, (p) => expect(p.locator("[data-fork-messages-problems]")).toHaveText("99+", { timeout: 15_000 })],
    ];
    for (const [alerts, settled] of states) {
      await load(page, `alerts=${alerts}`);
      await settled(page);
      expect(await measure(page), alerts).toEqual(calm);
      // The fullest Messages chip still fits in its slot.
      const slot = (await page.locator("[data-fork-messages-slot]").boundingBox())!;
      const chip = (await page.locator("[data-fork-messages]").boundingBox())!;
      expect(chip.x, alerts).toBeGreaterThanOrEqual(slot.x);
    }
    // A game opening is the one change without a reload.
    await load(page);
    await expect(page.locator("[data-fork-machines]")).toHaveAttribute("title", /Stacks/);
    await page.locator("[data-fork-more]").click();
    await page.locator("[data-fork-games]").click();
    await expect(page.locator("[data-fork-more-dot]")).toHaveAttribute("data-fork-more-dot", "game");
    expect(await measure(page), "game").toEqual(calm);
  });
}

test("the dot takes the worst of the three and the hover names why", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page, "alerts=lab,stacks,high");
  const chip = page.locator("[data-fork-machines]");
  await expect(page.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "amber");
  await expect(chip).toHaveAttribute("title", /Remote desktop is on for vivobook\./);
  await expect(chip).toHaveAttribute("title", /one was started by hand and nobody is using it/);
  await expect(chip).toHaveAttribute("title", /High CPU usage/, { timeout: 60_000 });
  await load(page, "alerts=stacks,critical");
  await expect(page.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "red");
  await expect(chip).toHaveAttribute("title", /^Memory is very tight/);
});

test("an alert opens its tab; otherwise the last tab used", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page);
  const chip = page.locator("[data-fork-machines]");
  const selected = page.getByRole("tab", { selected: true });
  await chip.click();
  await expect(selected).toHaveText("Lab");
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.locator("[data-fork-memory-total]")).toHaveText("Memory · 1.2 GB");
  await page.keyboard.press("Escape");
  await expect(chip).toBeFocused();
  await chip.click();
  await expect(selected).toHaveText("Memory");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(selected).toHaveText("Memory");
  await page.keyboard.press("Escape");

  await load(page, "alerts=stacks");
  await expect(page.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "amber");
  await chip.click();
  await expect(selected).toHaveText("Stacks");
  await expect(page.locator('[data-fork-stack="postgres"]')).toContainText("started by hand");
  await page.keyboard.press("Escape");

  await load(page, "alerts=stacks,critical");
  await expect(page.locator("[data-fork-machines-dot]")).toHaveAttribute("data-fork-machines-dot", "red");
  await chip.click();
  await expect(selected).toHaveText("Memory");
});

test("the tabs hold what left the footer, and arrow keys move between them", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page);
  await page.locator("[data-fork-machines]").click();
  await expect(page.locator("[data-fork-lab-words]")).toHaveText("Vivobook · 3 running");
  await page.locator("[data-fork-lab]").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Stacks" })).toBeFocused();
  await expect(page.locator('[data-fork-stack="firebase"]')).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-fork-memory-total]")).toHaveText("Memory · 1.2 GB");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Lab" })).toHaveAttribute("aria-selected", "true");
});

test("Messages opens the send bar and focus comes back to it", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page);
  const chip = page.locator("[data-fork-messages]");
  await chip.click();
  await expect(page.getByRole("button", { name: /Open messages view/ })).toBeVisible();
  await page.locator("[data-fork-broadcast]").click();
  const bar = page.locator("[data-fork-broadcast-bar]");
  await expect(bar).toBeVisible();
  await expect(page.locator("[data-fork-broadcast]")).toHaveCount(0);
  await expect(chip).toHaveClass(/text-accent/);
  // Above the footer, as before.
  const footer = (await page.locator("footer").boundingBox())!;
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
  await bar.getByLabel("Message", { exact: true }).fill("kept");
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(chip).toBeFocused();
  await chip.click();
  await page.locator("[data-fork-broadcast]").click();
  await expect(bar.getByLabel("Message", { exact: true })).toHaveValue("kept");
});

test("More holds Games and Ring, one level in", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await load(page);
  const chip = page.locator("[data-fork-more]");
  await chip.click();
  await expect(page.locator("[data-fork-ring]")).toContainText("Ringing: you are at Home.");
  await expect(page.getByRole("radio", { name: "At my places" })).toHaveAttribute("aria-checked", "true");
  await page.locator("[data-fork-games]").click();
  await expect(page.locator("[data-fork-games-panel]")).toBeVisible();
  await expect(page.locator("[data-fork-ring]")).toHaveCount(0);
  await expect(chip).toHaveAttribute("title", /A game is open\./);
  await page.evaluate(() => (window as unknown as { __gamesPanel: { hide(): void } }).__gamesPanel.hide());
  await expect(page.locator("[data-fork-more-dot]")).toHaveAttribute("data-fork-more-dot", "");
  await expect(chip).toBeFocused();

  await load(page, "alerts=ring");
  await expect(chip).toHaveAttribute("title", /location is off for MonoCode/);
  await expect(page.locator("[data-fork-more-dot]")).toHaveAttribute("data-fork-more-dot", "amber");
});

for (const [width, height] of [[900, 720], [420, 500], [320, 300]]) {
  test(`at ${width}×${height} chips are icons and no popover is clipped`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await load(page, `alerts=${ALL_ALERTS}`);
    await expect(page.locator("[data-fork-machines] span:not([data-fork-machines-dot])")).toBeHidden();
    await expect(page.locator("[data-fork-more] span:not([data-fork-more-dot])")).toBeHidden();
    await expect(page.locator("[data-fork-messages-word]")).toBeHidden();
    const frame = page.locator("[data-popover-side]").first();
    const fits = async () => {
      const box = (await frame.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    };
    await page.locator("[data-fork-machines]").click();
    for (const tab of ["Lab", "Stacks", "Memory"]) {
      await page.getByRole("tab", { name: tab }).click();
      await fits();
      // The last thing in a tall tab can still be scrolled to.
      const panel = page.getByRole("tabpanel");
      const reach = await panel.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        const rect = el.getBoundingClientRect();
        return { bottom: rect.bottom, innerBottom: window.innerHeight, scrolls: el.scrollHeight >= el.clientHeight };
      });
      expect(reach.bottom).toBeLessThanOrEqual(reach.innerBottom);
      expect(reach.scrolls).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.locator("[data-fork-more]").click();
    await fits();
    await page.keyboard.press("Escape");
    await page.locator("[data-fork-messages]").click();
    await fits();
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`screenshots, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1300, height: 800 });
    await load(page, `theme=${theme}&alerts=${ALL_ALERTS}`);
    await expect(page.locator("[data-fork-messages-problems]")).toHaveText("99+", { timeout: 15_000 });
    const shot = (name: string) =>
      page.screenshot({ path: `${dir}/${name}-${theme}.png`, clip: { x: 1300 - 760, y: 800 - 620, width: 760, height: 620 } });
    await shot("footer-alerts");
    await page.locator("[data-fork-machines]").click();
    for (const tab of ["Lab", "Stacks", "Memory"]) {
      await page.getByRole("tab", { name: tab }).click();
      await shot(`machines-${tab.toLowerCase()}`);
    }
    await page.keyboard.press("Escape");
    await page.locator("[data-fork-more]").click();
    await shot("more");
    await page.keyboard.press("Escape");
    await page.locator("[data-fork-messages]").click();
    await shot("messages");
    await page.locator("[data-fork-broadcast]").click();
    await shot("send-bar");
  });
}
