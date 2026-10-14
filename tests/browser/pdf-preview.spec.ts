import { expect, test } from "@playwright/test";

test("file preview draws every PDF page and zooms", async ({
  page,
}, testInfo) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.goto("/tests/browser/pdf-preview.html");

  const viewer = page.getByLabel("PDF preview: report.pdf");
  await expect(viewer).toBeVisible();
  const footer = page.locator("footer").first();
  await expect(footer).toContainText("1 / 2");

  // Each fixture page has black text and one coloured box. An undrawn canvas
  // is fully transparent, so only opaque pixels count.
  const ink = (name: string) =>
    page.getByLabel(name).evaluate((canvas: HTMLCanvasElement) => {
      const found = { text: false, box: false };
      const context = canvas.getContext("2d");
      if (!context) return found;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < data.length; index += 4) {
        const [red, green, blue, alpha] = data.subarray(index, index + 4);
        if (alpha < 255) continue;
        if (red < 60 && green < 60 && blue < 60) found.text = true;
        if (Math.max(red, blue) > 200 && green < 60) found.box = true;
      }
      return found;
    });
  const drawn = { text: true, box: true };
  await expect.poll(() => ink("Page 1"), { timeout: 15_000 }).toEqual(drawn);
  await expect.poll(() => ink("Page 2"), { timeout: 15_000 }).toEqual(drawn);
  await page.screenshot({ path: testInfo.outputPath("fit.png") });

  const pixels = () =>
    page
      .getByLabel("Page 1")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width);
  const sharpness = await pixels();
  const before = await page.getByLabel("Page 1").boundingBox();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(footer).toContainText("125%");
  await expect
    .poll(async () => (await page.getByLabel("Page 1").boundingBox())?.width)
    .toBeGreaterThan(before!.width * 1.2);
  // Redrawn at the new size, not just stretched.
  await expect.poll(pixels).toBeGreaterThan(sharpness * 1.2);

  await viewer.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(footer).toContainText("2 / 2");
  await page.screenshot({ path: testInfo.outputPath("zoomed.png") });

  expect(violations).toEqual([]);
});
