import { test, expect } from "@playwright/test";

test("focused canvas sends a key release when focus is lost", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/", { waitUntil: "load" });
  // Export availability precedes listener installation during startup.
  // Wait for the actual canvas handlers before sending keyboard input.
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.key_down === "function" &&
    typeof wasm_exports.key_up === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeydown === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeyup === "function");

  // Observe calls while forwarding them to the actual compiled WASM exports.
  await page.evaluate(() => {
    window.__keyTransitions = [];
    window.__domKeyTransitions = [];
    document.querySelector("#glcanvas").addEventListener("keydown", event => {
      window.__domKeyTransitions.push(event.code);
    }, true);
    const original = wasm_exports;
    // WASM export properties are non-configurable. Do not Proxy their methods:
    // ES Proxy invariants reject wrapped getters for such properties.
    wasm_exports = {
      ...original,
      key_down: (...args) => {
        window.__keyTransitions.push({ type: "key_down", key: args[0] });
        return original.key_down(...args);
      },
      key_up: (...args) => {
        window.__keyTransitions.push({ type: "key_up", key: args[0] });
        return original.key_up(...args);
      }
    };
  });

  const calibration = await page.evaluate(() => {
    wasm_exports.key_up(999, 0);
    const count = window.__keyTransitions.length;
    window.__keyTransitions.length = 0;
    const target = document.querySelector("#glcanvas");
    window.__handlerCalls = 0;
    const handler = target.onkeydown;
    target.onkeydown = function(event) {
      window.__handlerCalls++;
      return handler.call(this, event);
    };
    return count;
  });
  expect(calibration, "WASM export instrumentation must observe direct calls").toBe(1);
  const canvas = page.locator("#glcanvas");
  await canvas.click();
  await expect(canvas).toBeFocused();
  await page.keyboard.down("a");
  await page.waitForTimeout(100);
  const observed = await page.evaluate(() => ({
    focused: document.activeElement?.id,
    dom: window.__domKeyTransitions,
    wasm: window.__keyTransitions,
    handler: typeof document.querySelector("#glcanvas")?.onkeydown,
    handlerCalls: window.__handlerCalls
  }));
  expect(observed.wasm, JSON.stringify({ ...observed, errors })).toContainEqual({
    type: "key_down", key: 65
  });

  await canvas.evaluate(element => element.blur());
  await expect.poll(() => page.evaluate(() => window.__keyTransitions)).toContainEqual({
    type: "key_up", key: 65
  });

  await page.keyboard.up("a");
  const transitions = await page.evaluate(() => window.__keyTransitions.filter(
    event => event.key === 65
  ));
  expect(transitions).toEqual([
    { type: "key_down", key: 65 },
    { type: "key_up", key: 65 }
  ]);
  expect(errors).toEqual([]);
});
