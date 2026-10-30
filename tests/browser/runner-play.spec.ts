import { expect, test, type Page } from "@playwright/test";

// LAB_SHOTS: a folder for the screenshots. LAB_BROWSER: a Chromium to run
// when the one Playwright expects is not downloaded.
if (process.env.LAB_BROWSER) {
  test.use({ launchOptions: { executablePath: process.env.LAB_BROWSER } });
}

const HIT = "[data-runner-hit]";

async function open(page: Page, query = "") {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`/tests/browser/runner-play.html${query}`);
  await page.locator(HIT).waitFor({ state: "attached" });
}

/** The middle of the sprite right now, with the cursor parked on it so it waits. */
async function catchIt(page: Page) {
  let spot = { x: 0, y: 0 };
  for (let i = 0; i < 8; i++) {
    const box = (await page.locator(HIT).boundingBox())!;
    spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(spot.x, spot.y);
    const after = (await page.locator(HIT).boundingBox())!;
    if (Math.abs(after.x + after.width / 2 - spot.x) < 8) {
      return spot;
    }
  }
  return spot;
}

async function spriteBox(page: Page) {
  return (await page.locator(HIT).boundingBox())!;
}

async function ledgeTop(page: Page) {
  return (await page.getByLabel("Message").locator("..").boundingBox())!.y;
}

async function shoot(page: Page, dir: string, name: string) {
  const box = await spriteBox(page);
  const x = Math.max(0, Math.min(1000 - 240, box.x - 100));
  const y = Math.max(0, Math.min(700 - 160, box.y - 90));
  await page.screenshot({
    path: `${dir}/${name}.png`,
    clip: { x, y, width: 240, height: 160 },
  });
}

test("only the sprite takes the pointer", async ({ page }) => {
  await open(page);
  const hit = await spriteBox(page);
  expect(hit.width).toBe(28);
  expect(hit.height).toBe(22);
  await expect(page.locator(HIT)).toHaveCSS("cursor", "grab");

  const ownLayer = await page.evaluate(() => {
    const layer = document.querySelector("[data-runner-hit]")!.parentElement!;
    return getComputedStyle(layer).pointerEvents;
  });
  expect(ownLayer).toBe("none");

  // The composer underneath still takes clicks and typing, wherever the
  // sprite is, and the transcript button behind the layer still clicks.
  await page.getByLabel("Message").click({ position: { x: 300, y: 20 } });
  await page.keyboard.type("hello");
  await expect(page.getByLabel("Message")).toHaveValue("hello");
  await page.locator("[data-behind]").click();
  await expect(page.locator("[data-behind]")).toHaveText("Clicked 1");

  // Grabbing the blob leaves the caret in the composer.
  await page.getByLabel("Message").click({ position: { x: 300, y: 20 } });
  const spot = await catchIt(page);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByLabel("Message")).toBeFocused();
  await page.keyboard.type(" there");
  await expect(page.getByLabel("Message")).toHaveValue("hello there");
});

test("click, double click, cross, pet, drag, throw", async ({ page }, testInfo) => {
  const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
  await open(page);

  // Click: a hop with a "!".
  let spot = await catchIt(page);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('[data-runner-fx="bang"]')).toHaveCount(1);
  await page.waitForTimeout(120);
  await shoot(page, dir, "runner-click");
  const top = await ledgeTop(page);
  await page.waitForTimeout(500);

  // Double click: a backflip.
  spot = await catchIt(page);
  await page.mouse.click(spot.x, spot.y);
  await page.mouse.click(spot.x, spot.y);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector<HTMLElement>("svg.mascot-active")!.parentElement!.style.transform,
      ),
    )
    .toMatch(/rotate\(-\d/);
  await shoot(page, dir, "runner-flip");
  await page.waitForTimeout(700);

  // A few quick clicks: cross and red, then sprinting.
  spot = await catchIt(page);
  await page.mouse.click(spot.x, spot.y);
  await page.mouse.click(spot.x, spot.y);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator(".runner-cross")).toHaveCount(1);
  await shoot(page, dir, "runner-cross");
  await page.mouse.move(10, 10);
  const before = (await spriteBox(page)).x;
  await page.waitForTimeout(300);
  const after = (await spriteBox(page)).x;
  expect(Math.abs(after - before)).toBeGreaterThan(40);
  await expect(page.locator(".runner-cross")).toHaveCount(0, { timeout: 5000 });

  // Long press: hearts and closed eyes.
  spot = await catchIt(page);
  await page.mouse.down();
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-runner-fx="heart"]').first()).toBeAttached();
  await shoot(page, dir, "runner-pet");
  await page.mouse.up();
  await page.waitForTimeout(400);

  // Drag: it comes up and kicks.
  spot = await catchIt(page);
  await page.mouse.down();
  await page.mouse.move(spot.x + 30, spot.y - 120, { steps: 6 });
  await page.mouse.move(spot.x + 60, 250, { steps: 6 });
  await page.waitForTimeout(100);
  const held = await spriteBox(page);
  expect(held.y).toBeLessThan(300);
  await expect(page.locator(HIT)).toHaveCSS("cursor", "grabbing");
  await shoot(page, dir, "runner-held");

  // Throw: release with speed; it flies, then comes back to the ledge.
  await page.mouse.move(spot.x + 300, 150, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(60);
  await shoot(page, dir, "runner-throw");
  const flying = await spriteBox(page);
  expect(flying.y + flying.height).toBeLessThan(top - 20);
  await page.mouse.move(10, 10);
  await expect
    .poll(async () => {
      const box = await spriteBox(page);
      return Math.abs(box.y + box.height - top);
    }, { timeout: 6000 })
    .toBeLessThan(4);
  await page.screenshot({ path: `${dir}/runner-whole.png` });

  // Shake while held: stars after it lands.
  spot = await catchIt(page);
  await page.mouse.down();
  await page.mouse.move(spot.x, spot.y - 30, { steps: 3 });
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(spot.x + (i % 2 === 0 ? 30 : -30), spot.y - 30);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.mouse.move(10, 10);
  await expect
    .poll(() => page.locator(".mascot-stunned").count(), { timeout: 3000 })
    .toBe(1);
  await shoot(page, dir, "runner-dizzy");
});

test("dropping it on the chevron is a bonk", async ({ page }) => {
  await open(page, "?chevron=1");
  const chevron = (await page.getByLabel("Jump to latest").boundingBox())!;
  const spot = await catchIt(page);
  await page.mouse.down();
  await page.mouse.move(spot.x, spot.y - 40, { steps: 3 });
  await page.mouse.move(chevron.x + chevron.width / 2, spot.y - 60, { steps: 8 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.mouse.move(10, 10);
  await expect
    .poll(() => page.locator(".mascot-stunned").count(), { timeout: 3000 })
    .toBe(1);
});

test("a turn ending in hand lets it down gently, then it exits", async ({ page }) => {
  await open(page);
  const spot = await catchIt(page);
  await page.mouse.down();
  await page.mouse.move(spot.x, spot.y - 200, { steps: 6 });
  await page.waitForTimeout(80);
  await page.evaluate(() => (window as unknown as { __endTurn: () => void }).__endTurn());
  await page.waitForTimeout(150);
  await expect(page.locator("[data-exited]")).toHaveText("running");
  await expect(page.locator("[data-exited]")).toHaveText("exited", { timeout: 3000 });
  await page.mouse.up();
  await expect(page.locator(HIT)).toHaveCount(0);
});

test("reduced motion: no pick-up, simple reactions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.waitForTimeout(100);
  const start = await spriteBox(page);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y - 200, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  const after = await spriteBox(page);
  expect(after.y).toBe(start.y);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect(page.locator('[data-runner-fx="bang"]')).toHaveCount(1);
});

for (const theme of ["dark", "light"] as const) {
  // Math.random is pinned, so the same dice pick each antic; the clock is fake,
  // so a long turn takes no time.
  const ANTICS = [
    { name: "sit", dice: 0.02, at: 20_800 + 1200 },
    { name: "wave", dice: 0.25, at: 25_000 + 900 },
    { name: "look", dice: 0.45, at: 29_000 + 500 },
    { name: "dance", dice: 0.65, at: 33_000 + 900 },
    { name: "yawn", dice: 0.85, at: 37_000 + 800 },
  ];
  for (const { name, dice, at } of ANTICS) {
    test(`idle antic: ${name}, ${theme}`, async ({ page }, testInfo) => {
      const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
      await page.clock.install();
      await page.addInitScript((value) => {
        Math.random = () => value;
      }, dice);
      await open(page, `?theme=${theme}`);
      await page.clock.runFor(at);
      await shoot(page, dir, `runner-${name}-${theme}`);
    });
  }

  test(`naps on a long turn, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.clock.install();
    await page.addInitScript(() => {
      Math.random = () => 0.25;
    });
    await open(page, `?theme=${theme}`);
    await page.clock.fastForward(121_000);
    for (let i = 0; i < 40; i++) {
      await page.clock.runFor(2000);
      if ((await page.locator('[data-runner-fx="zzz"]').count()) > 0) {
        break;
      }
    }
    await expect(page.locator('[data-runner-fx="zzz"]').first()).toBeAttached();
    await page.clock.runFor(400);
    await shoot(page, dir, `runner-nap-${theme}`);

    // Something happens: the cursor comes close and it wakes.
    const box = await spriteBox(page);
    await page.mouse.move(box.x + 14, box.y + 8);
    await page.clock.runFor(1300);
    await expect(page.locator('[data-runner-fx="zzz"]')).toHaveCount(0);
  });

  test(`eats a coin and burps, ${theme}`, async ({ page }, testInfo) => {
    const dir = process.env.LAB_SHOTS ?? testInfo.outputDir;
    await page.clock.install();
    await page.addInitScript(() => {
      Math.random = () => 0.1;
    });
    await open(page, `?theme=${theme}`);
    let burped = false;
    for (let i = 0; i < 200 && !burped; i++) {
      await page.clock.runFor(100);
      burped = (await page.locator('[data-runner-fx="puff"]').count()) > 0;
    }
    expect(burped).toBe(true);
    await shoot(page, dir, `runner-burp-${theme}`);
  });
}
