#!/usr/bin/env node
// Issue #123 external-consumer qualification: renders the fresh
// `drawing-external-consumer` crate's compiled WASM fixture
// (`examples/consume.rs`) in a real Chromium page via Playwright, and
// confirms the canvas shows more than a flat clear color — proof that
// a separate crate depending on `miniquad-draw` via a path/Git
// dependency (not copied source) actually renders real geometry
// through the companion's public `Renderer`/`Batch` API.
//
// Usage: node experiments/drawing-comparison/verify-consumer-render.mjs
// Requires `node experiments/drawing-comparison/serve-drawing.mjs` built
// artifacts (see docs/drawing-companion.md for the exact build command)
// and a Playwright Chromium install (this session links the parent's
// `node_modules`; see docs/drawing-companion.md).
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.DRAWING_QUALIFICATION_PORT || 4280);

async function main() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const routes = {
      "/js/gl.js": "js/gl.js",
      "/js/miniquad.mjs": "js/miniquad.mjs",
      "/js/runtime.html": "js/runtime.html",
      "/js/runtime.mjs": "js/runtime.mjs",
      "/js/host-preferences.mjs": "js/host-preferences.mjs",
      "/qualification": "tests/browser/drawing-qualification.html",
      "/consumer.wasm": "experiments/drawing-comparison/external-consumer/target/wasm32-unknown-unknown/release/examples/consume.wasm",
    };
    const file = routes[pathname];
    if (!file) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const data = await readFile(resolve(root, file));
    const type = file.endsWith(".wasm")
      ? "application/wasm"
      : file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/javascript; charset=utf-8";
    response.writeHead(200, { "content-type": type });
    response.end(data);
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));

  const browser = await chromium.launch({
    args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/qualification`);
    await page.evaluate(async () => {
      const { mount } = await import("/js/miniquad.mjs");
      window.app = mount({
        container: document.querySelector("#scene"),
        wasmURL: "/consumer.wasm",
        title: "drawing-external-consumer fixture",
      });
      await window.app.ready;
    });
    await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    const image = PNG.sync.read(await canvas.screenshot());
    const colors = new Set();
    for (let i = 0; i < image.data.length; i += 4) {
      colors.add(image.data.subarray(i, i + 4).toString("hex"));
    }
    const result = { colorCount: colors.size, consoleErrors: errors };
    console.log(JSON.stringify(result));
    if (colors.size <= 8) {
      throw new Error("external-consumer fixture rendered only a clear color: " + JSON.stringify(result));
    }
    if (errors.length > 0) {
      throw new Error("external-consumer fixture raised console errors: " + JSON.stringify(result));
    }
    console.log("external-consumer fixture rendered real geometry through miniquad-draw's public API: PASS");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
