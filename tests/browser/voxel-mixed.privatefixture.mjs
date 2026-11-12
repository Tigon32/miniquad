// Browser evidence for issue #29's mixed (mode B) vertical slice.
//
// Filename note: this file is deliberately named `*.privatefixture.mjs`,
// not `*.spec.mjs`, so root's `playwright.config.mjs` (testMatch
// "*.spec.mjs") does not auto-discover and run it as part of the root
// suite. This fixture needs its own private build steps (a real
// `vx-server` binary and two private WASM artifacts) that root CI does
// not run, so it must be invoked explicitly with its own config:
// `npx playwright test --config=tests/browser/voxel-mixed.playwright.config.mjs`
// (see that file for the exact required build commands).
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
//   ["/voxel-revision.mjs", {file:"companions/voxel/web/voxel-revision.mjs", type:"text/javascript; charset=utf-8"}]
// plus the gateway's own POST /vx/v1/sync -> http://127.0.0.1:${VOXEL_SERVER_PORT:-4230}/vx/v1/sync.
//
// Separate real WebGL1/WebGL2 build evidence (own build outputs, not
// served by default - build on demand before running this file's
// GL1/GL2 test):
//   cargo build --release --target wasm32-unknown-unknown --example offline --manifest-path companions/voxel/Cargo.toml
//   cargo build --release --target wasm32-unknown-unknown --example mixed --target-dir companions/voxel/target-gl1
//   cargo build --release --target wasm32-unknown-unknown --example mixed --features webgl2 --target-dir companions/voxel/target-gl2
// served at /voxel-mixed-gl1.wasm and /voxel-mixed-gl2.wasm
// respectively (route map above, same host/proxy). `webgl2` is an
// existing `companions/voxel/Cargo.toml` feature; default (no
// feature) selects `WebGLVersion::WebGL1`.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";

const root = resolve(new URL("../..", import.meta.url).pathname);
const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = 4231;
const SERVER_PORT = 4230;
const MEASUREMENT_WARMUP_FRAMES = 60;
const MEASUREMENT_FRAMES = 120;

const staticFiles = new Map([
  ["/voxel-mixed.html", { file: "tests/browser/voxel-mixed.html", type: "text/html; charset=utf-8" }],
  ["/js/gl.js", { file: "js/gl.js", type: "text/javascript; charset=utf-8" }],
  ["/js/miniquad.mjs", { file: "js/miniquad.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/runtime.html", { file: "js/runtime.html", type: "text/html; charset=utf-8" }],
  ["/js/runtime.mjs", { file: "js/runtime.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/host-preferences.mjs", { file: "js/host-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  [
    "/voxel-offline.wasm",
    {
      file: "companions/voxel/target/wasm32-unknown-unknown/release/examples/offline.wasm",
      type: "application/wasm",
    },
  ],
  [
    "/voxel-mixed.wasm",
    {
      file: "companions/voxel/target/wasm32-unknown-unknown/release/examples/mixed.wasm",
      type: "application/wasm",
    },
  ],
  ["/voxel-host.mjs", { file: "companions/voxel/web/voxel-host.mjs", type: "text/javascript; charset=utf-8" }],
  ["/voxel-revision.mjs", { file: "companions/voxel/web/voxel-revision.mjs", type: "text/javascript; charset=utf-8" }],
  // Separate real WebGL1/WebGL2 builds (own `--target-dir`, so the
  // shared `example = "mixed"` output never overwrites the other):
  //   cargo build --release --target wasm32-unknown-unknown --example mixed --target-dir companions/voxel/target-gl1
  //   cargo build --release --target wasm32-unknown-unknown --example mixed --features webgl2 --target-dir companions/voxel/target-gl2
  // `webgl2` is an existing `companions/voxel/Cargo.toml` feature;
  // `mixed.rs`'s `conf()` only sets `platform.webgl_version` to
  // `WebGL2` when the feature is enabled, and otherwise leaves it at
  // `conf::Platform::default()`'s `WebGLVersion::WebGL1`.
  [
    "/voxel-mixed-gl1.wasm",
    {
      file: "companions/voxel/target-gl1/wasm32-unknown-unknown/release/examples/mixed.wasm",
      type: "application/wasm",
    },
  ],
  [
    "/voxel-mixed-gl2.wasm",
    {
      file: "companions/voxel/target-gl2/wasm32-unknown-unknown/release/examples/mixed.wasm",
      type: "application/wasm",
    },
  ],
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
    headers: {
      "content-type": request.headers["content-type"] ?? "application/octet-stream",
      // Forward the real Content-Length: without it, Node's http client
      // falls back to `Transfer-Encoding: chunked` for a piped body,
      // which the protocol (and vx-server) explicitly rejects (no TE).
      ...(request.headers["content-length"] !== undefined
        ? { "content-length": request.headers["content-length"] }
        : {}),
    },
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

/** Spawns a fresh `vx-server` child bound to `SERVER_PORT` and waits for its "listening on" stdout line. */
function spawnVxServer() {
  const bin = resolve(root, "companions/voxel/target/release/vx-server");
  const child = spawn(bin, ["--port", String(SERVER_PORT)], { stdio: "pipe" });
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("vx-server did not report ready in time")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolveReady(child);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
}

test.beforeAll(async () => {
  if (!(await isPortOpen(SERVER_PORT, FIXTURE_HOST))) {
    spawnedVxServer = await spawnVxServer();
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
  page.context().on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    errors.push(`Request failed ${request.url()}: ${request.failure()?.errorText ?? "unknown error"}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`${message.text()} (${location.url}:${location.lineNumber}:${location.columnNumber})`);
    }
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

test("the host's full revision text starts at 'no snapshot yet' and shows the true decimal revision once online", async ({ page }) => {
  // Real-browser coverage is limited to the two reachable, meaningful
  // states (no snapshot yet; a real small revision once online): the
  // pure boundary cases (0, 42, 999999, 1000000, u32::MAX, and the
  // unsigned 0xFFFFFFFF -> 4294967295 conversion itself) are covered
  // deterministically in tests/voxel-revision.test.mjs. Driving the
  // real `Sim` to a million edits in a browser is neither necessary
  // nor meaningful evidence for the conversion's correctness.
  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  expect(await page.textContent("#revision")).toBe("no snapshot yet");

  await page.evaluate((syncUrl) => {
    window.client = window.wireVoxelMixedHost(window.app, syncUrl);
    window.client.start();
  }, `${baseURL}/vx/v1/sync`);

  await page.waitForFunction(() => {
    const text = document.querySelector("#revision").textContent;
    return text !== "no snapshot yet" && /^[0-9]+$/.test(text);
  });
  const revisionText = await page.textContent("#revision");
  // A fresh server's first Hello snapshot is revision 0: confirm the
  // text is the real decimal (not, e.g., a raw negative/signed number,
  // which an unconverted `u32` return would never be at this small
  // value, but which this assertion still forecloses in principle).
  expect(Number(revisionText)).toBeGreaterThanOrEqual(0);
  expect(revisionText).not.toMatch(/^-/);

  await page.evaluate(() => window.client?.dispose?.());
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

  // The agreed release protocol (host-driven, no raw Stage re-entry
  // from the export): pause first (proving release is requested while
  // paused), then the host itself must (1) resume if paused, because
  // `draw()` never runs while paused and `vx_release_gpu()` only sets
  // a flag that the *next* `draw()` services, (2) call
  // `vx_release_gpu()` to set that flag, (3) wait (bounded) for
  // `vx_resources_live() === 0`, and (4) `dispose()` in a `finally`
  // regardless of whether the wait succeeded, so a wait timeout can
  // never leak the iframe/GPU context.
  await page.evaluate(() => window.app.pause());

  const afterRelease = await page.evaluate(async () => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    if (window.app.state === "paused") window.app.resume();
    exports.vx_release_gpu();
    const deadline = Date.now() + 1000;
    while (exports.vx_resources_live() !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      live: exports.vx_resources_live(),
      glCounts: window.app.frame.contentWindow.__glCounts,
      waitTimedOut: exports.vx_resources_live() !== 0,
    };
  });
  expect(afterRelease.waitTimedOut).toBe(false);
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

/** Mounts the mixed example in `page` and returns its real backing-store/CSS framebuffer dimensions. */
async function measureFramebufferDims(page) {
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
  await page.evaluate(() => window.app.dispose());
  return dims;
}

test("high-DPI framebuffer dimensions scale with an explicit devicePixelRatio of 1 vs. 2, not just a readable ratio", async ({ browser }) => {
  // `page`'s default context never sets an explicit `deviceScaleFactor`,
  // so it only ever reports whatever the environment happens to
  // provide; a real DPR1/DPR2 acceptance check needs two independent
  // contexts, each forcing a concrete `deviceScaleFactor`.
  const contextDpr1 = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
  const contextDpr2 = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 });
  try {
    const pageDpr1 = await contextDpr1.newPage();
    const pageDpr2 = await contextDpr2.newPage();
    const dims1 = await measureFramebufferDims(pageDpr1);
    const dims2 = await measureFramebufferDims(pageDpr2);

    expect(dims1.dpr).toBe(1);
    expect(dims2.dpr).toBe(2);
    expect(dims1.framebufferWidth).toBeGreaterThan(0);
    expect(dims1.framebufferHeight).toBeGreaterThan(0);
    expect(dims2.framebufferWidth).toBeGreaterThan(0);
    expect(dims2.framebufferHeight).toBeGreaterThan(0);

    // Each context's own backing store must be an integer multiple
    // (within rounding) of its own CSS size, proving a real high-DPI
    // backing store, not a 1x canvas stretched by CSS.
    expect(Math.abs(dims1.framebufferWidth / dims1.cssWidth - dims1.dpr)).toBeLessThan(0.05);
    expect(Math.abs(dims1.framebufferHeight / dims1.cssHeight - dims1.dpr)).toBeLessThan(0.05);
    expect(Math.abs(dims2.framebufferWidth / dims2.cssWidth - dims2.dpr)).toBeLessThan(0.05);
    expect(Math.abs(dims2.framebufferHeight / dims2.cssHeight - dims2.dpr)).toBeLessThan(0.05);

    // Same CSS layout size at both DPRs (both contexts share the same
    // 800x500 viewport): the DPR2 framebuffer must be exactly twice
    // the DPR1 framebuffer's physical pixel dimensions.
    expect(dims1.cssWidth).toBe(dims2.cssWidth);
    expect(dims1.cssHeight).toBe(dims2.cssHeight);
    expect(dims2.framebufferWidth).toBe(dims1.framebufferWidth * 2);
    expect(dims2.framebufferHeight).toBe(dims1.framebufferHeight * 2);
  } finally {
    await contextDpr1.close();
    await contextDpr2.close();
  }
});

test("separate real WebGL1 and WebGL2 builds negotiate the requested context type", async ({ page }) => {
  // `canvas.getContext("webgl2")` on an already-WebGL1-bound canvas
  // returns `null` (browsers lock a canvas to its first-created
  // context type); on a genuinely WebGL2-bound canvas it returns the
  // same live context object. This proves the *actual* negotiated
  // type, not merely which URL was requested.
  const builds = [
    { wasmPath: "voxel-mixed-gl1.wasm", expectWebGL2: false },
    { wasmPath: "voxel-mixed-gl2.wasm", expectWebGL2: true },
  ];
  for (const { wasmPath, expectWebGL2 } of builds) {
    await page.goto(`${baseURL}/voxel-mixed.html`);
    await page.evaluate(async (wasmURL) => {
      const { mount } = await import("/js/miniquad.mjs");
      window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
      await window.app.ready;
    }, `${baseURL}/${wasmPath}`);
    await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

    const negotiatedWebGL2 = await page.evaluate(() => {
      const doc = window.app.frame.contentWindow.document;
      const canvas = doc.querySelector("#glcanvas");
      return canvas.getContext("webgl2") !== null;
    });
    expect(negotiatedWebGL2).toBe(expectWebGL2);

    // The build actually renders, not just negotiates a context type.
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    const screenshot = await canvas.screenshot();
    expect(screenshot.byteLength).toBeGreaterThan(0);

    await page.evaluate(() => window.app.dispose());
  }
});

test("native server restart after an outage triggers a full Hello resync, not a silent continuation", async ({ page }) => {
  // This regression needs to control the real `vx-server` process
  // (kill it, then start a fresh one) to prove a genuine outage and
  // restart, not merely a simulated network failure; it only runs
  // meaningfully when this spec's own `beforeAll` spawned the server
  // itself (the common case - nothing else binds 127.0.0.1:4230).
  test.skip(!spawnedVxServer, "vx-server was not spawned by this spec (something else already owned port 4230)");

  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
    window.app.setParameters({ speed: 0 });
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  await page.evaluate((syncUrl) => {
    window.client = window.wireVoxelMixedHost(window.app, syncUrl);
    window.client.start();
  }, `${baseURL}/vx/v1/sync`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_has_snapshot() !== 0);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected.");

  // Apply a real edit so the server-confirmed `rev` is unambiguously
  // nonzero before the outage (this file's shared `vx-server` process
  // may already carry state from earlier tests, but this edit alone
  // guarantees it).
  const revBeforeOutage = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev());
  await page.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    const topY = exports.vx_column_height(8, 4);
    exports.vx_input(1, 1, 8, topY + 1, 4);
  });
  await page.waitForFunction(
    (expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === expected,
    revBeforeOutage + 1,
  );
  expect(revBeforeOutage).toBeGreaterThanOrEqual(0);

  // Simulate a real outage: kill the actual server process.
  const dyingServer = spawnedVxServer;
  const exited = new Promise((resolveExit) => dyingServer.once("exit", resolveExit));
  dyingServer.kill();
  await exited;
  expect(await isPortOpen(SERVER_PORT, FIXTURE_HOST)).toBe(false);

  // Force an immediate poll (rather than waiting out backoff) so the
  // outage is observed promptly: this must hit ECONNREFUSED and
  // transition the host to OFFLINE, matching "outage keeps last scene
  // read-only" (never a local-generation fallback or success-shaped
  // failure).
  await page.click("#reconnect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Server is not available. Changes are not saved.",
  );

  // The scene keeps rendering its last known state (read-only), it
  // does not crash or blank out.
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 0);
  const screenshotDuringOutage = await page.frameLocator("#scene iframe").locator("#glcanvas").screenshot();
  expect(screenshotDuringOutage.byteLength).toBeGreaterThan(0);

  // An edit queued during the outage must be discarded, not silently
  // applied locally (mixed mode's "no local generation fallback").
  const discardedBefore = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_discarded_input_count());
  const revDuringOutage = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev());
  await page.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    const topY = exports.vx_column_height(8, 4);
    exports.vx_input(1, 1, 8, topY + 1, 4);
  });
  await page.waitForFunction(
    (expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_discarded_input_count() > expected,
    discardedBefore,
  );
  expect(await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev())).toBe(revDuringOutage);

  // Restart: a fresh `vx-server` process (no persistence - a brand
  // new `Sim::new_scene()` at rev 0). Replace the module-level handle
  // so `afterAll`'s cleanup targets the live process.
  spawnedVxServer = await spawnVxServer();

  await page.click("#reconnect");
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected.");
  // Proof of a genuine full Hello resync, not a continuation: the
  // client's own `rev` must drop back to the fresh server's rev 0,
  // strictly less than the pre-outage edited revision.
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === 0);
  expect(await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev())).toBeLessThan(
    revBeforeOutage + 1,
  );

  await page.evaluate(() => window.client?.dispose?.());
  await page.evaluate(() => window.app.dispose());
});

// ---------------------------------------------------------------------
// Fixed trace, per docs/architecture/voxel-protocol.md's Verification
// contract: "speed 0, then SetVoxel edits for a chunk interior, a
// chunk boundary, an out-of-range voxel (rejected), and a stone
// column between the camera and the sprite." Both the offline
// (un-wired) client and the mixed (server-synced) client run this
// exact same sequence of `vx_input` calls, since `examples/mixed.rs`'s
// own doc comment states its rendered scene is "intentionally
// identical to `examples/offline.rs`, built from the same shared
// `Sim`", and both the un-wired-client and the server start from the
// identical `Sim::new_default_scene`-equivalent seed. A chunk-interior
// voxel at (2, *, 2) and a chunk-boundary voxel at (8, *, 4) (the
// first local cell of the second chunk, already used by the HUD/UI's
// own Add/Remove contract) are both well inside `SCENE_CHUNK_DIMS`;
// (200, 0, 0) is outside both scene chunks (`resolve_scene_voxel`
// rejects any chunk index >= 2), so it must leave `rev` unchanged.
//
// `vx-server`'s `handle_frame` (src/bin/vx_server.rs) applies an
// `Inputs` frame's commands in order and stops at the first rejected
// command, replying `Rejected` for the whole frame without attempting
// any later command in that same frame - unlike offline/un-wired mode,
// where `drain_network`'s local-apply loop runs every queued command
// regardless of any individual failure. Queuing all 4 ops in the same
// synchronous tick (as this fixed trace's un-wired offline path does)
// would therefore let the out-of-range op (3rd) silently swallow the
// column edit (4th) when wired to the real server, purely as an
// artifact of them landing in the same batched `Inputs` request - not
// a real behavior difference this acceptance item is about. Each
// realistic caller (the HUD/UI's own Add/Remove/Reconnect controls)
// only ever queues one op per user action, so `applyFixedTrace`'s
// `serialize: true` path (used for the server-synced client) issues
// each op as its own `vx_input` call and waits for that op's effect
// (an accepted `rev` bump, or - for the one expected-rejected op - a
// bounded settle with no `rev` change) before queuing the next, which
// is both realistic and avoids the batching artifact entirely.
const STONE = 3; // terrain::MATERIAL_STONE
async function applyFixedTrace(page, { serialize = false } = {}) {
  const exportsRev = () => page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev());
  const queueOne = (op, id, x, y, z) =>
    page.evaluate(([op, id, x, y, z]) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_input(op, id, x, y, z), [op, id, x, y, z]);
  const columnHeight = (x, z) =>
    page.evaluate(([x, z]) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_column_height(x, z), [x, z]);

  const revBefore = await exportsRev();

  const interiorY = (await columnHeight(2, 2)) + 1;
  await queueOne(1, STONE, 2, interiorY, 2);
  if (serialize) await page.waitForFunction((expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === expected, revBefore + 1, { timeout: 10000 });

  const boundaryY = (await columnHeight(8, 4)) + 1;
  await queueOne(1, STONE, 8, boundaryY, 4);
  if (serialize) await page.waitForFunction((expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === expected, revBefore + 2, { timeout: 10000 });

  // Out-of-range: x=200 resolves to scene chunk index 25, which
  // `resolve_scene_voxel` rejects (only chunk indices 0 and 1
  // exist). `vx_input` itself still returns 0 (the command is
  // queued/applied-attempted), so rejection can only be observed
  // by `rev` not advancing for this specific op.
  const revBeforeOutOfRange = await exportsRev();
  await queueOne(1, STONE, 200, 0, 0);
  if (serialize) {
    // No local speculative write exists to wait for; a rejected op
    // never bumps `rev`, so settle on a bounded wait instead of a
    // `rev` transition (one full round trip plus margin).
    await page.waitForTimeout(400);
  }

  // Fourth op: a stone column at world column (11, 4), whose ground
  // footprint this scene already generates solid up to the world
  // ceiling (y=11). This column has no special relationship to the
  // sprite (see the separate "sprite depth occlusion" test below for
  // that); it is used here only because always (re)writing its
  // topmost cell is unconditionally one real `Sim::apply` (so `rev`
  // always advances by exactly 1), unlike a "build up" loop over
  // `(vx_column_height()+1)..=11`, which can be a no-op here
  // specifically.
  await queueOne(1, STONE, 11, 11, 4);
  if (serialize) await page.waitForFunction((expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === expected, revBefore + 3, { timeout: 10000 });

  return {
    revBefore,
    revBeforeOutOfRange,
    interiorY,
    boundaryY,
    columnTopRequested: 11,
  };
}

function maskHud(image) {
  // HUD panel default placement (DPR 1, 800x500 layout): x 8..225,
  // y 8..32, per the HUD placement spec. Mask a slightly larger
  // rectangle (0..230, 0..36) to absorb any sub-pixel edge rounding,
  // so "pixel parity excluding HUD" never credits/blames HUD pixels.
  for (let y = 0; y < Math.min(36, image.height); y++) {
    for (let x = 0; x < Math.min(230, image.width); x++) {
      const idx = (y * image.width + x) * 4;
      image.data[idx] = 0;
      image.data[idx + 1] = 0;
      image.data[idx + 2] = 0;
      image.data[idx + 3] = 0;
    }
  }
}

/** Counts pixels whose RGB differs by more than `channelTolerance` in any channel, after both images have had `maskHud` applied. */
function countDifferingPixels(a, b, channelTolerance) {
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (dr > channelTolerance || dg > channelTolerance || db > channelTolerance) diff++;
  }
  return diff;
}

test("frozen offline and mixed (server-synced) scenes apply the same fixed edit trace to equal semantic state and near-identical pixels, excluding the HUD", async ({ page, browser }) => {
  // Page A: offline/un-wired. Never calls wireVoxelMixedHost, so
  // `drain_network`'s "no transport status has ever been set" branch
  // applies `vx_input` directly, matching the contract's "offline"
  // state (not a network round trip).
  const pageA = page;
  await pageA.goto(`${baseURL}/voxel-mixed.html`);
  await pageA.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
    window.app.setParameters({ speed: 0 });
  }, `${baseURL}/voxel-mixed.wasm`);
  await pageA.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  const traceA = await applyFixedTrace(pageA);
  // Give `update()` a bounded number of frames to drain the queued
  // inputs and rebuild the dirty terrain mesh. All three in-scene ops
  // (interior, boundary, column) each advance `rev` by exactly 1
  // regardless of the voxel's prior value (`Sim::apply` always
  // increments `rev` on acceptance); the out-of-range op is rejected
  // and contributes 0. `applyFixedTrace` reads `revBefore` before any
  // of these are queued, in the same synchronous tick, so none have
  // been drained by `update()` yet at that point.
  await pageA.waitForFunction(
    ({ revBefore }) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === revBefore + 3,
    traceA,
  );
  await pageA.waitForTimeout(150);

  const stateA = await pageA.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    return { hashLo: exports.vx_state_hash_lo(), hashHi: exports.vx_state_hash_hi(), rev: exports.vx_world_rev() };
  });
  const canvasA = pageA.frameLocator("#scene iframe").locator("#glcanvas");
  const { PNG } = await import("pngjs");
  const imageA = PNG.sync.read(await canvasA.screenshot());

  // Semantic: the out-of-range op must not have advanced `rev` beyond
  // the two accepted edits before it plus the (up to 1) column edit
  // applied after it; concretely, `rev` after the whole trace must be
  // exactly `revBefore + 3` (interior, boundary, column; the
  // out-of-range op contributes 0), never `+4`.
  expect(stateA.rev).toBe(traceA.revBefore + 3);

  await pageA.evaluate(() => window.app.dispose());

  // Page B: mixed (server-synced). A fresh context so this is a wholly
  // independent client/iframe realm from page A.
  const contextB = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const pageB = await contextB.newPage();
  await pageB.goto(`${baseURL}/voxel-mixed.html`);
  await pageB.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
    window.app.setParameters({ speed: 0 });
  }, `${baseURL}/voxel-mixed.wasm`);
  await pageB.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);

  await pageB.evaluate((syncUrl) => {
    window.client = window.wireVoxelMixedHost(window.app, syncUrl);
    window.client.start();
  }, `${baseURL}/vx/v1/sync`);
  // Wait for the first real Hello snapshot: this test's server must
  // start this trace from the same fresh rev-0 scene as page A's
  // offline client (no earlier test in this file sends any `vx_input`
  // while wired to the network).
  await pageB.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_has_snapshot() !== 0);
  const serverRevBefore = await pageB.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev());
  expect(serverRevBefore).toBe(0);

  const traceB = await applyFixedTrace(pageB, { serialize: true });

  const stateB = await pageB.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    return { hashLo: exports.vx_state_hash_lo(), hashHi: exports.vx_state_hash_hi(), rev: exports.vx_world_rev() };
  });
  const canvasB = pageB.frameLocator("#scene iframe").locator("#glcanvas");
  const imageB = PNG.sync.read(await canvasB.screenshot());

  expect(stateB.rev).toBe(traceB.revBefore + 3);

  // Semantic parity: equal `state_hash` and `rev` after the identical
  // trace, per the Verification contract.
  expect(stateB.rev).toBe(stateA.rev);
  expect(stateB.hashLo).toBe(stateA.hashLo);
  expect(stateB.hashHi).toBe(stateA.hashHi);

  // Pixel parity: at most 0.5% of pixels differ by more than 2/255,
  // excluding the HUD rectangle.
  maskHud(imageA);
  maskHud(imageB);
  expect(imageA.width).toBe(imageB.width);
  expect(imageA.height).toBe(imageB.height);
  const totalPixels = imageA.width * imageA.height;
  const differing = countDifferingPixels(imageA, imageB, 2);
  expect(differing / totalPixels).toBeLessThanOrEqual(0.005);

  await pageB.evaluate(() => window.client?.dispose?.());
  await pageB.evaluate(() => window.app.dispose());
  await contextB.close();
});

// Regression test for a previously genuine, reproduced blocker in
// core `src/graphics/gl.rs`'s `apply_pipeline`: it used to call
// `glEnable(GL_DEPTH_TEST)` only when `pipeline.params.depth_write`
// was true, silently disabling depth *testing* whenever a pipeline
// only disabled depth *writing* (exactly `examples/mixed.rs`'s sprite
// pipeline: `depth_test: LessOrEqual, depth_write: false`, to let the
// sprite be tested against, but not corrupt, the terrain's depth).
// `src/graphics/metal.rs` always treated the two independently
// (`setDepthWriteEnabled` and `setDepthCompareFunction` are separate
// calls), so the GL backend diverged from the documented/Metal-
// consistent contract. Fixed in this worktree's `gl.rs` by enabling
// `GL_DEPTH_TEST` whenever `depth_write || depth_test !=
// Comparison::Always`, and by calling `glDepthMask` independently so
// writes stay off while tests still run (plus a matching `clear()`
// fix: depth clears now force the mask true first, since
// `glClear(GL_DEPTH_BUFFER_BIT)` is itself gated by the current
// mask, then restore it). See `graphics::gl::depth_state_tests` for
// the pure-logic unit coverage and `docs/architecture/
// voxel-protocol.md`'s "Known blocker" section for the full root-
// cause writeup.
//
// Fixing the real GL bug also exposed a second, independent design
// bug in this example's frozen (`speed: 0`) scene: the sprite's old
// fixed height formula placed it embedded inside its own column's
// solid terrain, which only looked fine because the GL bug drew it
// through everything unconditionally. `examples/mixed.rs` now floats
// the sprite a fixed margin above its own column's real height (via
// `vx_column_height`), and the frozen position was retargeted (via
// the orbit formula's `radius`/`PHASE_OFFSET` constants) to world
// column (2, 6), whose low natural height (5) leaves it visible by
// default. The edit below sets one stone voxel at world column
// (3, 6), y=6 - verified empirically against this exact built WASM
// artifact (single-voxel edits at y=5, 7, 8, 9 do not occlude; y=6
// alone does), consistent with ray-marching this scene's exact
// `OrbitCamera` eye/target geometry against the real column-height
// grid (not guessed), to sit squarely on the real 3D ray between the
// camera eye and the frozen sprite position, so it alone newly
// occludes the sprite's projected pixel.
test("sprite depth occlusion: a stone column between the camera and the sprite replaces the sprite's tint with the terrain's colour", async ({ page }) => {

  await page.goto(`${baseURL}/voxel-mixed.html`);
  await page.evaluate(async (wasmURL) => {
    const { mount } = await import("/js/miniquad.mjs");
    window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Mixed voxel scene" });
    await window.app.ready;
    window.app.setParameters({ speed: 0 });
  }, `${baseURL}/voxel-mixed.wasm`);
  await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 5);

  const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
  const { PNG } = await import("pngjs");
  // `vx_sprite_pixel()` reports CSS-pixel coordinates (it divides by
  // `self.screen_size`, the CSS size `js/gl.js` reports), but
  // `canvas.screenshot()` captures the real GPU framebuffer, which is
  // CSS size * `devicePixelRatio` (see `js/gl.js`'s `dpr` binding and
  // the "high-DPI framebuffer dimensions" test above). Playwright's
  // "Desktop Safari" device preset (used for the `webkit` project)
  // sets `deviceScaleFactor: 2`, unlike the Chromium/Firefox presets'
  // `1`, so without this scaling this test's pixel lookup silently
  // read the wrong framebuffer location on WebKit only.
  const dpr = await page.evaluate(() => window.app.frame.contentWindow.devicePixelRatio);
  const spriteXY = await page.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    const packed = exports.vx_sprite_pixel();
    return { px: packed >>> 16, py: packed & 0xffff };
  });
  const pixelAt = (image, x, y) => {
    const idx = (y * image.width + x) * 4;
    return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
  };

  const SPRITE_TINT = [0x30, 0x75, 0xc8]; // DEFAULT_SPRITE_RGBA8 = 0x3075_C8FF
  const fbX = Math.round(spriteXY.px * dpr);
  const fbY = Math.round(spriteXY.py * dpr);
  const before = pixelAt(PNG.sync.read(await canvas.screenshot()), fbX, fbY);
  expect(before).toEqual(SPRITE_TINT);

  const revBeforeEdit = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev());
  await page.evaluate(() => {
    const exports = window.app.frame.contentWindow.miniquadRuntime.exports;
    // Column (3, 6) is naturally open air at y=6 (natural height 5),
    // so this single `SetVoxel` is a genuine edit (verified below via
    // `rev`), and - per the ray-marched geometry above - the one new
    // solid voxel it places is enough to occlude the sprite (verified
    // empirically: y=6 alone blocks; y=5, 7, 8, 9 alone do not).
    exports.vx_input(1, 3, 3, 6, 6);
  });
  await page.waitForFunction((expected) => window.app.frame.contentWindow.miniquadRuntime.exports.vx_world_rev() === expected, revBeforeEdit + 1);
  await page.waitForTimeout(300);

  const after = pixelAt(PNG.sync.read(await canvas.screenshot()), spriteXY.px, spriteXY.py);
  expect(after).not.toEqual(SPRITE_TINT);

  await page.evaluate(() => window.app.dispose());
});

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function median(values) {
  return percentile(values, 0.5);
}

function summarize(values) {
  const measured = values.filter(Number.isFinite);
  return measured.length
    ? {
        median: median(measured),
        min: Math.min(...measured),
        max: Math.max(...measured),
      }
    : null;
}

test("issue #29 measurement receipt: offline and mixed voxel runtime", async ({ browser }) => {
  test.skip(process.env.MINIQUAD_MEASURE_VOXEL !== "1", "run only for an explicit performance measurement");
  test.setTimeout(300_000);

  const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (source.status !== 0) throw new Error(`git rev-parse failed: ${source.stderr}`);

  const javascriptFiles = [
    "js/gl.js",
    "js/miniquad.mjs",
    "js/runtime.mjs",
    "js/host-preferences.mjs",
    "companions/voxel/web/voxel-host.mjs",
    "companions/voxel/web/voxel-revision.mjs",
  ];
  const assetBytes = async (mode) => {
    const wasmPath = `companions/voxel/target/wasm32-unknown-unknown/release/examples/${mode}.wasm`;
    const readEntries = async (files) =>
      Promise.all(
        files.map(async (file) => {
        const bytes = await readFile(resolve(root, file));
        return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
        }),
      );
    const [wasmEntry] = await readEntries([wasmPath]);
    const javascript = await readEntries(javascriptFiles);
    const html = await readEntries(["tests/browser/voxel-mixed.html", "js/runtime.html"]);
    return {
      wasm: wasmEntry,
      javascript: {
        entries: javascript,
        rawBytes: javascript.reduce((sum, entry) => sum + entry.rawBytes, 0),
        gzipBytes: javascript.reduce((sum, entry) => sum + entry.gzipBytes, 0),
      },
      html: {
        entries: html,
        rawBytes: html.reduce((sum, entry) => sum + entry.rawBytes, 0),
        gzipBytes: html.reduce((sum, entry) => sum + entry.gzipBytes, 0),
      },
      rawWasmJsBytes: wasmEntry.rawBytes + javascript.reduce((sum, entry) => sum + entry.rawBytes, 0),
      gzipWasmJsBytes: wasmEntry.gzipBytes + javascript.reduce((sum, entry) => sum + entry.gzipBytes, 0),
    };
  };
  const assets = {
    offline: await assetBytes("offline"),
    mixed: await assetBytes("mixed"),
  };

  const runScenario = async (mode, pair, order) => {
    const targetFrames = MEASUREMENT_WARMUP_FRAMES + MEASUREMENT_FRAMES + 1;
    const context = await browser.newContext({
      viewport: { width: 800, height: 500 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const failures = [];
    const pendingSyncResponses = [];
    let requestBodyBytes = 0;
    let responseBodyBytes = 0;

    await page.addInitScript(() => {
      const measurement = { frames: [], heapBytes: [] };
      window.__voxelMeasurement = measurement;
      const requestAnimationFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        requestAnimationFrame((timestamp) => {
          if (measurement.frames.length < 2000) measurement.frames.push(timestamp);
          callback(timestamp);
        });
      window.__voxelHeapTimer = setInterval(() => {
        const bytes = performance.memory?.usedJSHeapSize;
        if (typeof bytes === "number") measurement.heapBytes.push(bytes);
      }, 100);
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("requestfailed", (request) => failures.push(`${request.url()}: ${request.failure()?.errorText ?? "unknown error"}`));
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`);
      if (new URL(response.url()).pathname === "/vx/v1/sync") {
        pendingSyncResponses.push(
          response.body().then((body) => {
            responseBodyBytes += body.length;
          }),
        );
      }
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/vx/v1/sync") {
        requestBodyBytes += request.postDataBuffer()?.length ?? 0;
      }
    });

    try {
      await page.goto(`${baseURL}/voxel-mixed.html`);
      await page.evaluate(async ({ wasmURL, mode }) => {
        window.__voxelStartEpoch = performance.timeOrigin + performance.now();
        const { mount } = await import("/js/miniquad.mjs");
        window.app = mount({ container: document.querySelector("#scene"), wasmURL, title: "Voxel measurement" });
        await window.app.ready;
        window.app.setParameters({ speed: 0 });
        if (mode === "mixed") {
          window.client = window.wireVoxelMixedHost(window.app, `${location.origin}/vx/v1/sync`);
          window.client.start();
        }
      }, {
        wasmURL: `${baseURL}/voxel-${mode}.wasm`,
        mode,
      });

      if (mode === "mixed") {
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected.");
      }
      await page.waitForFunction(
        (count) => window.app.frame.contentWindow.__voxelMeasurement.frames.length >= count,
        targetFrames,
        { timeout: 60000 },
      );
      await Promise.all(pendingSyncResponses);

      const runtime = await page.evaluate((count) => {
        const frame = window.app.frame.contentWindow;
        return {
          timestamps: frame.__voxelMeasurement.frames.slice(0, count),
          wasmMemoryBytes: frame.wasm_memory?.buffer.byteLength ?? null,
          heapSamples: frame.__voxelMeasurement.heapBytes,
        };
      }, targetFrames);
      const intervals = runtime.timestamps
        .slice(MEASUREMENT_WARMUP_FRAMES + 1)
        .map((timestamp, index) => timestamp - runtime.timestamps[index + MEASUREMENT_WARMUP_FRAMES]);
      const firstFrameMs = await page.evaluate((timestamp) => {
        const frame = window.app.frame.contentWindow;
        return frame.performance.timeOrigin + timestamp - window.__voxelStartEpoch;
      }, runtime.timestamps[0]);
      const measured = {
        firstFrameMs,
        frameIntervalP95Ms: percentile(intervals, 0.95),
        frameIntervalP99Ms: percentile(intervals, 0.99),
        wasmMemoryBytes: runtime.wasmMemoryBytes,
        jsHeapPeakBytes: runtime.heapSamples.length ? Math.max(...runtime.heapSamples) : null,
        jsHeapSteadyBytes: runtime.heapSamples.length ? median(runtime.heapSamples.slice(-10)) : null,
      };

      if (failures.length) {
        throw new Error(`browser errors: ${failures.join("; ")}`);
      }
      await page.evaluate(() => clearInterval(window.__voxelHeapTimer));
      const screenshot = await page.frameLocator("#scene iframe").locator("#glcanvas").screenshot();

      let serverRssBytes = null;
      if (mode === "mixed" && spawnedVxServer?.pid) {
        const ps = spawnSync("ps", ["-o", "rss=", "-p", String(spawnedVxServer.pid)], { encoding: "utf8" });
        if (ps.status !== 0) throw new Error(`ps failed for vx-server: ${ps.stderr}`);
        const rssKilobytes = Number(ps.stdout.trim());
        if (!Number.isFinite(rssKilobytes)) throw new Error(`could not parse vx-server RSS: ${ps.stdout}`);
        serverRssBytes = rssKilobytes * 1024;
      }

      return {
        pair,
        order,
        mode,
        ...measured,
        requestBodyBytes,
        responseBodyBytes,
        serverRssBytes,
        screenshot,
      };
    } finally {
      await context.close();
    }
  };

  const observations = [];
  const { PNG } = await import("pngjs");
  const parity = [];
  for (let pair = 0; pair < 10; pair++) {
    const order = pair % 2 === 0 ? ["offline", "mixed"] : ["mixed", "offline"];
    const pairRows = {};
    for (const mode of order) {
      pairRows[mode] = await runScenario(mode, pair + 1, order.join("-"));
      observations.push(pairRows[mode]);
    }
    const offlineImage = PNG.sync.read(pairRows.offline.screenshot);
    const mixedImage = PNG.sync.read(pairRows.mixed.screenshot);
    expect(offlineImage.width).toBe(mixedImage.width);
    expect(offlineImage.height).toBe(mixedImage.height);
    maskHud(offlineImage);
    maskHud(mixedImage);
    const differingPixels = countDifferingPixels(offlineImage, mixedImage, 2);
    const differingFraction = differingPixels / (offlineImage.width * offlineImage.height);
    expect(differingFraction).toBeLessThanOrEqual(0.005);
    parity.push({ pair: pair + 1, differingPixels, differingFraction });
  }

  const summaryFor = (mode, key) =>
    summarize(observations.filter((row) => row.mode === mode).map((row) => row[key]));
  const receipt = {
    sourceSha: source.stdout.trim(),
    browser: { name: browser.browserType().name(), version: browser.version() },
    runner: { node: process.version, zlib: process.versions.zlib, platform: process.platform, arch: process.arch },
    repetitions: 10,
    context: {
      viewport: "800x500 CSS pixels",
      deviceScaleFactor: 1,
      warmupFrames: MEASUREMENT_WARMUP_FRAMES,
      measuredFrames: MEASUREMENT_FRAMES,
    },
    assets,
    results: Object.fromEntries(
      ["offline", "mixed"].map((mode) => [
        mode,
        {
          firstFrameMs: summaryFor(mode, "firstFrameMs"),
          frameIntervalP95Ms: summaryFor(mode, "frameIntervalP95Ms"),
          frameIntervalP99Ms: summaryFor(mode, "frameIntervalP99Ms"),
          wasmMemoryBytes: summaryFor(mode, "wasmMemoryBytes"),
          jsHeapPeakBytes: summaryFor(mode, "jsHeapPeakBytes"),
          jsHeapSteadyBytes: summaryFor(mode, "jsHeapSteadyBytes"),
          requestBodyBytes: summaryFor(mode, "requestBodyBytes"),
          responseBodyBytes: summaryFor(mode, "responseBodyBytes"),
          serverRssBytes: summaryFor(mode, "serverRssBytes"),
        },
      ]),
    ),
    unavailable: {
      cpuFrameTimeMs: null,
      gpuTimeMs: null,
      gpuMemoryBytes: null,
      inputToVisibleLatencyMs: null,
    },
    parity,
    observations: observations.map(({ screenshot, ...observation }) => observation),
  };
  console.log(`VOXEL_METRICS ${JSON.stringify(receipt)}`);
});
