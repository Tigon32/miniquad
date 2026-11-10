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
    const original = wasm_exports;
    wasm_exports = new Proxy(original, {
      get(target, name) {
        const method = target[name];
        if (name === "key_down" || name === "key_up") {
          return (...args) => {
            window.__keyTransitions.push({ type: name, key: args[0] });
            return method(...args);
          };
        }
        return method;
      }
    });
  });

  const canvas = page.locator("#glcanvas");
  await canvas.focus();
  await page.keyboard.down("a");
  await expect.poll(() => page.evaluate(() => window.__keyTransitions)).toContainEqual({
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
