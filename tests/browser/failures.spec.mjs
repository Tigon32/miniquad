import { test, expect } from "@playwright/test";

function watchErrors(page) {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", error => errors.push(error.message));
  return errors;
}

test("missing compiled WASM reports a failure and does not start frames", async ({page}) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    window.__frameCount = 0;
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = function(...args) {
      window.__frameCount++;
      return original.apply(this, args);
    };
  });
  await page.route("**/quad.wasm", route =>
    route.fulfill({status:404, contentType:"application/wasm", body:""}));
  await page.goto("/", {waitUntil:"load"});
  await expect.poll(() => errors.some(message =>
    message.includes("WASM HTTP request failed: 404"))).toBe(true);
  expect(await page.evaluate(() => window.__frameCount)).toBe(0);
});

test("a missing canvas reports its requirement before starting WASM", async ({page}) => {
  const errors = watchErrors(page);
  let wasmRequests = 0;
  page.on("request", request => {
    if (request.url().endsWith("/quad.wasm")) wasmRequests++;
  });
  await page.route("**/", route =>
    route.fulfill({status:200,contentType:"text/html",
      body:'<!doctype html><script src="/js/gl.js"></script><script>load("/quad.wasm")</script>'}));
  await page.goto("/", {waitUntil:"load"});
  await expect.poll(() => errors.some(message =>
    message.includes("Miniquad requires a #glcanvas element"))).toBe(true);
  expect(wasmRequests).toBe(0);
});

test("an unavailable WebGL context stops startup before any frame", async ({page}) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    window.__frameCount = 0;
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = function(...args) {
      window.__frameCount++;
      return original.apply(this, args);
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind,...args) {
      if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
      return originalGetContext.call(this,kind,...args);
    };
  });
  await page.goto("/", {waitUntil:"load"});
  await expect.poll(() => errors.some(message =>
    message.includes("WebGL") && message.includes("context is unavailable"))).toBe(true);
  expect(await page.evaluate(() => window.__frameCount)).toBe(0);
});

test("a wrong ABI version stops the real compiled WASM before main", async ({page}) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    window.__frameCount = 0;
    const originalRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function(...args) {
      window.__frameCount++;
      return originalRAF.apply(this,args);
    };
    window.__instantiateCount = 0;
    window.__versionCallCount = 0;
    const originalInstantiate = WebAssembly.instantiate;
    Object.defineProperty(WebAssembly, "instantiate", {
      configurable: true,
      writable: true,
      value: async function(...args) {
        window.__instantiateCount++;
        const result = await originalInstantiate.apply(this,args);
        return {
          exports: new Proxy(result.exports,{
            get(target,name) {
              if (name === "crate_version") {
                window.__versionCallCount++;
                return () => 999;
              }
              return Reflect.get(target,name);
            }
          })
        };
      }
    });
  });
  await page.goto("/", {waitUntil:"load"});
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({
    instantiateCount: window.__instantiateCount,
    versionCallCount: window.__versionCallCount,
    frameCount: window.__frameCount,
    exportsType: typeof wasm_exports
  }));
  expect(errors.some(message => message.includes("WASM ABI version mismatch")),
    "A wrong ABI must fail startup. " + JSON.stringify({state, errors})).toBe(true);
  expect(state.frameCount).toBe(0);
});
