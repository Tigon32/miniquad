import { test, expect } from "@playwright/test";

test("a context-lost event stops WASM rendering and reports reload requirement", async ({ page }) => {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.frame === "function" && typeof gl === "object");

  await page.evaluate(() => {
    window.__framesBeforeLoss = 0;
    const original = wasm_exports;
    wasm_exports = {
      ...original,
      frame(...args) {
        window.__framesBeforeLoss++;
        return original.frame(...args);
      }
    };
  });
  await page.waitForFunction(() => window.__framesBeforeLoss >= 3, null, { timeout: 10000 });

  const frames = await page.evaluate(() => {
    document.querySelector("#glcanvas").dispatchEvent(new Event("webglcontextlost"));
    return window.__framesBeforeLoss;
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__framesBeforeLoss)).toBe(frames);
  expect(errors).toContain("WebGL context lost; reload is required");
});

test("a synthetic restoration does not restart an invalid GPU resource graph", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.frame === "function" && typeof gl === "object");
  const stopped = await page.evaluate(() => {
    const canvas = document.querySelector("#glcanvas");
    canvas.dispatchEvent(new Event("webglcontextlost"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    return webgl_context_lost;
  });
  expect(stopped).toBe(true);
});
