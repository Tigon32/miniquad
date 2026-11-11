import { test, expect } from "@playwright/test";

// Regression for issue #141 (js/gl.js:1282,1285): the native platforms
// (for example src/native/macos.rs mouse_moved) send mouse_motion_event
// while the cursor is free and raw_mouse_motion while the cursor is
// grabbed, never both. The browser bridge must match that contract.
//
// Chromium under CDP automation refuses requestPointerLock on an
// unfocused render view (microsoft/playwright#20956); this test runs
// only where the real pointer-lock grant is observable.
test("pointer-locked canvas sends only raw mouse motion, not absolute motion", async ({page, browserName}) => {
  test.skip(browserName !== "firefox", "Chromium/WebKit automation denies requestPointerLock (playwright#20956); verified separately in Firefox.");
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.goto("/",{waitUntil:"load"});
  await page.waitForFunction(()=>typeof wasm_exports === "object" &&
    typeof wasm_exports.mouse_move === "function" &&
    typeof document.querySelector("#glcanvas")?.onmousemove === "function");

  await page.evaluate(()=>{
    window.__motion=[];
    const original=wasm_exports;
    wasm_exports={
      ...original,
      mouse_move(x,y) {
        window.__motion.push({type:"absolute",x,y});
        return original.mouse_move(x,y);
      },
      raw_mouse_move(dx,dy) {
        window.__motion.push({type:"raw",dx,dy});
        return original.raw_mouse_move(dx,dy);
      }
    };
    const canvas=document.querySelector("#glcanvas");
    canvas.addEventListener("mousedown", ()=>importObject.env.sapp_set_cursor_grab(true));
  });

  const canvas=page.locator("#glcanvas");
  const box=await canvas.boundingBox();
  await page.mouse.move(box.x+10,box.y+10);
  await canvas.click();
  await page.waitForFunction(()=>document.pointerLockElement === document.querySelector("#glcanvas"));

  await page.evaluate(()=>{window.__motion=[];});
  await page.mouse.move(box.x+40,box.y+40);
  await page.mouse.move(box.x+70,box.y+55);

  const grabbedMotion=await page.evaluate(()=>window.__motion);
  expect(grabbedMotion.length).toBeGreaterThan(0);
  expect(grabbedMotion.every(event=>event.type==="raw")).toBe(true);

  await page.evaluate(()=>{document.exitPointerLock();});
  await page.waitForFunction(()=>document.pointerLockElement === null);

  await page.evaluate(()=>{window.__motion=[];});
  await page.mouse.move(box.x+100,box.y+80);

  const freeMotion=await page.evaluate(()=>window.__motion);
  expect(freeMotion.length).toBeGreaterThan(0);
  expect(freeMotion.every(event=>event.type==="absolute")).toBe(true);

  expect(errors).toEqual([]);
});
