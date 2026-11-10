import { test, expect } from "@playwright/test";

test("WEBGL_lose_context stops compiled WASM frames without synthetic events", async ({ page }) => {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.frame === "function" && typeof gl === "object");
  await page.evaluate(() => {
    window.__physicalLossFrames = 0;
    const original = wasm_exports;
    wasm_exports = {
      ...original,
      frame(...args) {
        window.__physicalLossFrames++;
        return original.frame(...args);
      }
    };
  });
  await page.waitForFunction(() => window.__physicalLossFrames >= 3, null, { timeout: 10000 });

  const extension = await page.evaluate(() => {
    const loss = gl.getExtension("WEBGL_lose_context");
    if (!loss) return false;
    loss.loseContext();
    return true;
  });
  expect(extension, "Chromium must expose WEBGL_lose_context for this acceptance").toBe(true);
  await page.waitForFunction(() => webgl_context_lost === true, null, { timeout: 10000 });
  const state = await page.evaluate(() => ({
    frames: window.__physicalLossFrames,
    contextLost: gl.isContextLost(),
    stopped: webgl_context_lost
  }));
  expect(state.contextLost).toBe(true);
  expect(state.stopped).toBe(true);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__physicalLossFrames)).toBe(state.frames);
  expect(errors).toContain("WebGL context lost; reload is required");
});
