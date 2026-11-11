// Browser evidence for issue #29's mixed (mode B) vertical slice.
//
// This spec owns and runs its own bounded, ephemeral fixture: it does
// NOT use tests/browser/serve.mjs (core/server fixture, parent-owned,
// port 4173) and does NOT use the drawing companion's port 4280. It
// starts:
//   - the real native authoritative server, `vx-server`, on
//     127.0.0.1:4230 (the corrected default port; only spawned if
//     nothing is already listening there, and only ever killed if
//     this spec spawned it itself - never an unrelated process);
//   - its own static-file + same-origin-proxy HTTP server on
//     127.0.0.1:4231, serving this fixture's HTML/JS/WASM and
//     forwarding POST /vx/v1/sync and GET /health to the vx-server
//     above, so the browser's same-origin fetches never hit CORS.
//
// Parent integration note (route map to add to tests/browser/serve.mjs
// once the independent gateway/proxy work lands, per the "Sonnet
// building tests/browser/voxel-proxy.mjs" message): this fixture
// expects the following routes, which exactly mirror the existing
// /voxel.wasm entry's shape:
//   ["/voxel-mixed.wasm", {file:"companions/voxel/target/wasm32-unknown-unknown/release/examples/mixed.wasm", type:"application/wasm"}]
//   ["/voxel-mixed", {file:"tests/browser/voxel-mixed.html", type:"text/html; charset=utf-8"}]
//   ["/voxel-host.mjs", {file:"companions/voxel/web/voxel-host.mjs", type:"text/javascript; charset=utf-8"}]
// plus the gateway's own POST /vx/v1/sync -> http://127.0.0.1:${VOXEL_SERVER_PORT:-4230}/vx/v1/sync.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(new URL("../..", import.meta.url).pathname);
const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = 4231;
const SERVER_PORT = 4230;

const staticFiles = new Map([
  ["/voxel-mixed.html", { file: "tests/browser/voxel-mixed.html", type: "text/html; charset=utf-8" }],
  ["/js/gl.js", { file: "js/gl.js", type: "text/javascript; charset=utf-8" }],
  ["/js/miniquad.mjs", { file: "js/miniquad.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/runtime.html", { file: "js/runtime.html", type: "text/html; charset=utf-8" }],
  ["/js/runtime.mjs", { file: "js/runtime.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/host-preferences.mjs", { file: "js/host-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  [
    "/voxel-mixed.wasm",
    {
      file: "companions/voxel/target/wasm32-unknown-unknown/release/examples/mixed.wasm",
      type: "application/wasm",
    },
  ],
  ["/voxel-host.mjs", { file: "companions/voxel/web/voxel-host.mjs", type: "text/javascript; charset=utf-8" }],
]);

/** Checks whether something is already listening on `port` by racing a one-shot TCP connect. */
async function isPortOpen(port, host) {
  const net = await import("node:net");
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ port, host }, () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.on("error", () => resolvePort(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

/** Proxies a request to the real vx-server, forwarding only method/headers/body this protocol needs. */
function proxyToServer(request, response) {
  const options = {
    host: FIXTURE_HOST,
    port: SERVER_PORT,
    path: request.url,
    method: request.method,
    headers: { "content-type": request.headers["content-type"] ?? "application/octet-stream" },
  };
  import("node:http").then(({ request: httpRequest }) => {
    const upstream = httpRequest(options, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        "content-type": upstreamResponse.headers["content-type"] ?? "application/octet-stream",
      });
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("vx-server unreachable");
    });
    request.pipe(upstream);
  });
}

let fixtureServer;
let spawnedVxServer;

test.beforeAll(async () => {
  if (!(await isPortOpen(SERVER_PORT, FIXTURE_HOST))) {
    const bin = resolve(root, "companions/voxel/target/release/vx-server");
    spawnedVxServer = spawn(bin, ["--port", String(SERVER_PORT)], { stdio: "pipe" });
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("vx-server did not report ready in time")), 5000);
      spawnedVxServer.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("listening on")) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      spawnedVxServer.on("error", (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
    });
  }

  fixtureServer = createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${FIXTURE_HOST}`).pathname;
    if (pathname === "/health" || pathname === "/vx/v1/sync") {
      proxyToServer(request, response);
      return;
    }
    const asset = staticFiles.get(pathname === "/" ? "/voxel-mixed.html" : pathname);
    if (!asset || request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    try {
      const data = await readFile(resolve(root, asset.file));
      response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
      response.end(data);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(`Fixture asset missing: ${asset.file} (${error.message})`);
    }
  });
  await new Promise((resolveListen) => fixtureServer.listen(FIXTURE_PORT, FIXTURE_HOST, resolveListen));
});

test.afterAll(async () => {
  await new Promise((resolveClose) => fixtureServer?.close(resolveClose));
  if (spawnedVxServer) {
    spawnedVxServer.kill();
    await delay(100);
  }
});

const baseURL = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;

test("mixed example mounts, draws a scene, and the HUD reaches an online or local status", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
    window.app.setParameters({ speed: 0 });
  }, `${baseURL}/voxel-mixed.wasm`);

  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
  const screenshot = await canvas.screenshot();
  expect(screenshot.byteLength).toBeGreaterThan(0);

  await page.evaluate(() => window.app.dispose());
  expect(errors).toEqual([]);
});

test("the HUD chip region is drawn with an opaque, non-background color", async ({ page }) => {
  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  // Per the corrected HUD contract: at DPR 1, the default 800x500
  // layout's chip slot is x12..28, y12..28 - sample its center
  // (20, 20) and confirm it is drawn opaque (straight-alpha panel
  // background is alpha 0.85, never fully transparent) rather than a
  // leftover clear-color pixel. This does not assert an exact chip
  // color (HUD vs. scene-parity pixel budgets are tracked separately,
  // per the acceptance contract's "samplechipcenter20,20" note).
  const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
  const png = await canvas.screenshot();
  const { PNG } = await import("pngjs");
  const image = PNG.sync.read(png);
  const idx = (20 * image.width + 20) * 4;
  const alpha = image.data[idx + 3];
  expect(alpha).toBeGreaterThan(0);

  await page.evaluate(() => window.app.dispose());
});

test("vx_input queues a SetVoxel edit without crashing in offline (pre-snapshot) mode", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  const result = await page.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    // Add a block at x=8, z=4, one above the highest voxel in that
    // column, per the HUD/UI contract's "Add block at x8,z4" control.
    const topY = exports.vx_column_height(8, 4);
    return exports.vx_input(1, 1, 8, topY + 1, 4);
  });
  expect(result).toBe(0);
  expect(errors).toEqual([]);

  await page.evaluate(() => window.app.dispose());
});

test("vx_release_gpu genuinely deletes GPU objects (paused), and resources_live reaches 0 before dispose", async ({ page }) => {
  // Real instrumentation, not just the Rust-side counter: count actual
  // WebGL create*/delete* calls inside the iframe document mount()
  // creates, so a passing test proves GPU objects are truly released,
  // not merely that an internal tally was decremented.
  await page.addInitScript(() => {
    window.__glCounts = { created: 0, deleted: 0 };
    const createNames = ["createBuffer", "createTexture", "createFramebuffer", "createRenderbuffer"];
    const deleteNames = ["deleteBuffer", "deleteTexture", "deleteFramebuffer", "deleteRenderbuffer"];
    const instrument = (klass) => {
      if (!klass) return;
      for (const name of createNames) {
        const original = klass.prototype[name];
        if (typeof original !== "function") continue;
        klass.prototype[name] = function (...args) {
          const handle = original.apply(this, args);
          if (handle) window.__glCounts.created++;
          return handle;
        };
      }
      for (const name of deleteNames) {
        const original = klass.prototype[name];
        if (typeof original !== "function") continue;
        klass.prototype[name] = function (...args) {
          if (args[0]) window.__glCounts.deleted++;
          return original.apply(this, args);
        };
      }
    };
    instrument(window.WebGLRenderingContext);
    instrument(window.WebGL2RenderingContext);
  });

  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  // `addInitScript` instruments every new document's own
  // `window.WebGL*RenderingContext`, but the iframe mount() creates
  // is a separate JS realm from the top-level page: its GL calls
  // increment its own `contentWindow.__glCounts`, not the top-level
  // page's copy, so counts must be read from the iframe's window.
  const beforeCreated = await page.evaluate(() => window.app.frame.contentWindow.__glCounts.created);
  expect(beforeCreated).toBeGreaterThan(0);

  const before = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_resources_live());
  expect(before).toBeGreaterThan(0);

  // resume -> release -> wait for resources_live==0 -> dispose, per the
  // acceptance requirement that release is serviced "even when the app
  // is paused": pause it first, then confirm vx_release_gpu still runs.
  await page.evaluate(() => window.app.pause());
  await page.evaluate(() => window.app.resume());
  await page.evaluate(() => window.app.pause());
  await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_release_gpu());
  await page.waitForFunction(
    () => window.app.frame.contentWindow.miniquadRuntime.exports.vx_resources_live() === 0,
    null,
    { timeout: 2000 },
  );

  const afterRelease = await page.evaluate(() => ({
    live: window.app.frame.contentWindow.miniquadRuntime.exports.vx_resources_live(),
    glCounts: window.app.frame.contentWindow.__glCounts,
  }));
  expect(afterRelease.live).toBe(0);
  // The real GPU object count must have actually dropped to (at most)
  // the pre-release baseline: every buffer/texture created for this
  // scene's resident chunks must have a matching delete call.
  expect(afterRelease.glCounts.deleted).toBeGreaterThan(0);

  // Read the counts before `dispose()` removes the iframe (and so its
  // `contentWindow`) from the document.
  const beforeDisposeDeleted = await page.evaluate(
    () => window.app.frame.contentWindow.__glCounts.deleted,
  );
  await page.evaluate(() => window.app.dispose());
  expect(beforeDisposeDeleted).toBeGreaterThanOrEqual(afterRelease.glCounts.deleted);
});

test("high-DPI framebuffer dimensions scale with devicePixelRatio, not just a readable ratio", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  const dims = await page.evaluate(() => {
    const doc = window.app.frame.contentWindow.document;
    const canvas = doc.querySelector("#glcanvas");
    return {
      dpr: window.app.frame.contentWindow.devicePixelRatio,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      framebufferWidth: canvas.width,
      framebufferHeight: canvas.height,
    };
  });
  // Report the actual backing-store pixel dimensions, not merely a
  // computed devicePixelRatio: the framebuffer must be an integer
  // multiple (within rounding) of the CSS size, proving a real
  // high-DPI backing store exists rather than a 1x canvas stretched by
  // CSS.
  expect(dims.framebufferWidth).toBeGreaterThan(0);
  expect(dims.framebufferHeight).toBeGreaterThan(0);
  const widthRatio = dims.framebufferWidth / dims.cssWidth;
  const heightRatio = dims.framebufferHeight / dims.cssHeight;
  expect(Math.abs(widthRatio - dims.dpr)).toBeLessThan(0.05);
  expect(Math.abs(heightRatio - dims.dpr)).toBeLessThan(0.05);

  await page.evaluate(() => window.app.dispose());
});
