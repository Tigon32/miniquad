import { test, expect } from "@playwright/test";

test("mouse release outside the canvas reaches the real WASM callback once", async ({page}) => {
  await page.goto("/", {waitUntil:"load"});
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.mouse_down === "function" &&
    typeof wasm_exports.mouse_up === "function" &&
    typeof document.querySelector("#glcanvas")?.onmousedown === "function");
  await page.evaluate(() => {
    const original = wasm_exports;
    window.__pointerEvents = [];
    wasm_exports = {
      ...original,
      mouse_down(x, y, button) {
        window.__pointerEvents.push({kind:"down", button});
        return original.mouse_down(x, y, button);
      },
      mouse_up(x, y, button) {
        window.__pointerEvents.push({kind:"up", button});
        return original.mouse_up(x, y, button);
      }
    };
  });

  const bounds = await page.locator("#glcanvas").boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 50, bounds.y + 50);
  await page.mouse.down({button:"left"});
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + bounds.height + 20);
  await page.mouse.up({button:"left"});

  const observed = await page.evaluate(() => window.__pointerEvents);
  expect(observed).toEqual([{kind:"down",button:0},{kind:"up",button:0}]);
});

test("clipboard paste is isolated from a separately focused input", async ({page}) => {
  await page.goto("/", {waitUntil:"load"});
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.on_clipboard_paste === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeydown === "function");
  const result = await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "unrelated-field";
    input.value = "private field value";
    document.body.appendChild(input);
    input.focus();
    const original = wasm_exports;
    let wasmCalls = 0;
    wasm_exports = {
      ...original,
      on_clipboard_paste(...args) {
        wasmCalls++;
        return original.on_clipboard_paste(...args);
      }
    };
    const event = new Event("paste", {bubbles:true,cancelable:true});
    Object.defineProperty(event,"clipboardData", {
      value:{getData(type){return type==="text/plain"?"private text":"";}}
    });
    window.dispatchEvent(event);
    return {
      focused:document.activeElement===input,
      value:input.value,
      prevented:event.defaultPrevented,
      wasmCalls
    };
  });
  expect(result).toEqual({
    focused:true,
    value:"private field value",
    prevented:false,
    wasmCalls:0
  });
});
