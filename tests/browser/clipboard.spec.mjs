import { test, expect } from "@playwright/test";

test("real browser transfers focused Unicode clipboard paste into WASM", async ({ page }) => {
  const failures = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() =>
    typeof wasm_exports === "object" &&
    typeof wasm_exports.on_clipboard_paste === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeydown === "function");

  const received = await page.evaluate(() => {
    const canvas = document.querySelector("#glcanvas");
    canvas.focus();
    const actual = wasm_exports;
    const calls = [];
    wasm_exports = {
      ...actual,
      on_clipboard_paste(ptr, len) {
        const bytes = new Uint8Array(wasm_memory.buffer, ptr, len);
        calls.push({
          length: len,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        });
        return actual.on_clipboard_paste(ptr, len);
      }
    };

    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "é🎮\u0000z");
    const event = new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData
    });
    window.dispatchEvent(event);
    return { calls, prevented: event.defaultPrevented, focused: document.activeElement === canvas };
  });

  expect(received.focused).toBe(true);
  expect(received.prevented).toBe(true);
  expect(received.calls).toEqual([{ length: 8, text: "é🎮\u0000z" }]);
  expect(failures).toEqual([]);
});

test("real browser rejects oversized clipboard paste without a WASM allocation", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() =>
    typeof wasm_exports === "object" &&
    typeof wasm_exports.on_clipboard_paste === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeydown === "function");

  const state = await page.evaluate(() => {
    const canvas = document.querySelector("#glcanvas");
    canvas.focus();
    const actual = wasm_exports;
    let allocations = 0;
    wasm_exports = {
      ...actual,
      allocate_vec_u8(len) {
        allocations++;
        return actual.allocate_vec_u8(len);
      }
    };
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "a".repeat(1024 * 1024 + 1));
    const event = new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData
    });
    window.dispatchEvent(event);
    return { allocations, prevented: event.defaultPrevented };
  });
  expect(state).toEqual({ allocations: 0, prevented: true });
});
