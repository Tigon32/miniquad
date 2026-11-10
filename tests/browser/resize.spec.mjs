import { test, expect } from "@playwright/test";

test("compiled WASM survives a canvas resize and continues rendering", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__resizedFrameCount = 0;
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = function(callback) {
      return original.call(this, timestamp => {
        window.__resizedFrameCount++;
        return callback(timestamp);
      });
    };
  });

  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__resizedFrameCount > 3, null, { timeout: 10000 });

  const before = await page.locator("#glcanvas").evaluate(canvas => ({
    width: canvas.width, height: canvas.height
  }));
  await page.locator("#glcanvas").evaluate(canvas => {
    canvas.style.width = "480px";
    canvas.style.height = "240px";
    window.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.locator("#glcanvas").evaluate(canvas => ({
    width: canvas.width,
    height: canvas.height
  }))).not.toEqual(before);

  const expected = await page.locator("#glcanvas").evaluate(canvas => {
    const scale = dpi_scale();
    return {
      width: Math.floor(canvas.clientWidth * scale),
      height: Math.floor(canvas.clientHeight * scale)
    };
  });
  const actual = await page.locator("#glcanvas").evaluate(canvas => ({
    width: canvas.width, height: canvas.height
  }));
  expect(actual).toEqual(expected);
  const count = await page.evaluate(() => window.__resizedFrameCount);
  await page.waitForFunction(previous => window.__resizedFrameCount > previous + 3,
    count, { timeout: 10000 });
  expect(errors).toEqual([]);
});
