// Private browser tests for the 2D hex board example (`docs/hex-2d-contract.md`
// section 4, MADR 0012, issue #134). Private server at
// `experiments/hex-2d-browser/serve.mjs`, port 4292 only (reserved for
// this worker). Run `node experiments/hex-2d-browser/build.mjs` first
// to produce `hex_board_webgl{1,2}.wasm`.
//
// This suite manages its own server (like `tests/browser/starter.spec.mjs`
// manages its own on port 4174) instead of the root `playwright.config.js`
// `webServer`/`baseURL` (4173), which is parent-owned and unrelated to
// this example.
//
// Pointer tests click through `page.frameLocator(...).locator("#glcanvas")`
// at a position relative to the canvas element, which lets Playwright
// resolve the real nested-iframe and canvas offset for us, rather than
// a literal page-chrome pixel offset this file's own CSS would have to
// reproduce exactly. This is a deliberate, documented substitution for
// section 4.2's literal "page point (37, 53)": the same requirement
// (the pointer bridge removes canvas/container offset) is checked by
// clicking at the logical point the test expects, through whatever
// offset Playwright resolves.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";

const PORT = 4292;
const ADDRESS = "http://127.0.0.1:" + PORT;
let server;

test.beforeAll(async () => {
  let output = "";
  let spawnError;
  server = spawn(process.execPath, ["experiments/hex-2d-browser/serve.mjs"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.on("error", error => { spawnError = error; });
  server.stdout.on("data", data => { output += data; });
  server.stderr.on("data", data => { output += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError || server.exitCode !== null) {
      throw new Error("Cannot start the hex-2d browser fixture: " + (spawnError?.message || output));
    }
    try {
      const response = await fetch(ADDRESS + "/health");
      if (response.ok) return;
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("hex-2d browser fixture did not become ready: " + output);
});

test.afterAll(() => {
  server?.kill();
});

/** `f32` bit pattern of `value`, for `hex_probe_cell_at`. */
function floatBits(value) {
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = value;
  return new Uint32Array(buffer)[0];
}

/** Decodes a `u32` bit pattern back to `f32`, for the layout probes. */
function bitsToFloat(bits) {
  const buffer = new ArrayBuffer(4);
  new Uint32Array(buffer)[0] = bits;
  return new Float32Array(buffer)[0];
}

/** The nested runtime frame (`js/runtime.html`) that owns `wasm_exports`. */
function runtimeFrame(page) {
  const frame = page.frames().find(f => f.url().includes("runtime.html"));
  if (!frame) throw new Error("runtime frame not found");
  return frame;
}

function canvasLocator(page) {
  return page.frameLocator("#scene iframe").locator("#glcanvas");
}

// Dispatches a real OS-level click at the logical (x, y) canvas point using
// page.mouse.click on computed absolute page coordinates, instead of
// frameLocator(...).click({position}). The frameLocator position click adds
// an extra box+position rounding layer (observed to shift an integer target
// coordinate by 1 CSS pixel, e.g. y=240 -> clientY=239), which breaks exact
// lattice-tie assertions. Computing the absolute page point from the live
// iframe's own getBoundingClientRect() and clicking with page.mouse avoids
// that extra rounding layer while still exercising the real canvas/container
// offset math the application must handle.
async function clickAt(page, x, y) {
  const origin = await page.evaluate(() => {
    const iframe = document.querySelector("#scene iframe");
    const rect = iframe.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  // Round to a whole CSS pixel before dispatch. The container's flex
  // layout can give the iframe a fractional top/left (observed: 119.67px);
  // passing that fractional absolute coordinate straight into
  // page.mouse.click made Chromium and Firefox round/truncate it
  // differently (Chromium rounded to the intended pixel, Firefox
  // truncated one pixel short), which broke exact lattice-tie
  // assertions in Firefox only. Rounding first removes the fractional
  // part so there is nothing left for the two engines to disagree on.
  await page.mouse.click(Math.round(origin.left + x), Math.round(origin.top + y));
}

async function callExport(page, name, ...args) {
  return runtimeFrame(page).evaluate(
    ({ name, args }) => window.wasm_exports[name](...args),
    { name, args }
  );
}

async function waitRunning(page) {
  await expect(page.locator("#hex-status")).toContainText("Scene: running", { timeout: 15000 });
}

async function gotoBoard(page, { webgl = 1 } = {}) {
  await page.goto(ADDRESS + "/?webgl=" + webgl, { waitUntil: "load" });
  await waitRunning(page);
}

async function layoutProbes(page) {
  return {
    radius: bitsToFloat(await callExport(page, "hex_probe_layout_radius_bits")),
    originX: bitsToFloat(await callExport(page, "hex_probe_layout_origin_x_bits")),
    originY: bitsToFloat(await callExport(page, "hex_probe_layout_origin_y_bits"))
  };
}

/** Reads one RGB pixel from a screenshot buffer at backing-store `(x, y)`. */
function pixelAt(png, x, y) {
  const offset = (y * png.width + x) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

function assertClose(actual, expected, tolerance, what) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i]), what + " channel " + i).toBeLessThanOrEqual(tolerance);
  }
}

const THEME_COLORS = [
  { clear: [0xff, 0xff, 0xff], cell: [0x7d, 0x90, 0xa8], selected: [0x0a, 0x2f, 0x6e], marker: [0xff, 0xff, 0xff] },
  { clear: [0x10, 0x14, 0x18], cell: [0x56, 0x66, 0x7a], selected: [0xb8, 0xd8, 0xff], marker: [0x10, 0x14, 0x18] },
  { clear: [0x00, 0x00, 0x00], cell: [0xff, 0xff, 0xff], selected: [0xff, 0xd4, 0x00], marker: [0x00, 0x00, 0x00] }
];

const TOLERANCE = 8;

// docs/hex-2d-contract.md section 4.3: logical points for theme 0, both
// orientations, with the selected cell (-2, 1). Themes 1 and 2 reuse the
// same points with their own colors (see THEME_COLORS).
const FLAT_TOP_POINTS = [
  { point: [240, 240], expect: "cell" },
  { point: [430, 333.53], expect: "cell" },
  { point: [439, 333.53], expect: "clear" },
  { point: [267, 255.59], expect: "clear" },
  { point: [132, 240], expect: "marker" },
  { point: [154, 240], expect: "selected" }
];
const POINTY_TOP_POINTS = [
  { point: [240, 240], expect: "cell" },
  { point: [333.53, 430], expect: "cell" },
  { point: [333.53, 439], expect: "clear" },
  { point: [255.59, 267], expect: "clear" },
  { point: [146.47, 186], expect: "marker" },
  { point: [146.47, 208], expect: "selected" }
];

test.describe("environment (section 4.1)", () => {
  for (const webgl of [1, 2]) {
    test("WebGL" + webgl + " build requests the matching context type", async ({ page }) => {
      const requests = [];
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        window.__hexContexts = [];
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          const result = original.call(this, kind, ...rest);
          window.__hexContexts.push({ kind, ok: result !== null, isWebGL2: typeof WebGL2RenderingContext !== "undefined" && result instanceof WebGL2RenderingContext });
          return result;
        };
      });
      page.on("response", response => {
        const url = new URL(response.url());
        if (url.origin !== ADDRESS) requests.push(response.url());
      });

      await gotoBoard(page, { webgl });

      const contexts = await runtimeFrame(page).evaluate(() => window.__hexContexts);
      const requested = contexts.filter(c => c.kind === "webgl" || c.kind === "webgl2");
      expect(requested.length).toBeGreaterThan(0);
      if (webgl === 1) {
        expect(requested.some(c => c.kind === "webgl" && c.ok)).toBe(true);
        expect(requested.every(c => !c.isWebGL2)).toBe(true);
      } else {
        expect(requested.some(c => c.kind === "webgl2" && c.ok && c.isWebGL2)).toBe(true);
      }
      expect(requests, "same-origin only").toEqual([]);
    });
  }
});

test.describe("standard layout (section 4.2)", () => {
  test("480x480 gives radius 36 and origin (240, 240)", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const layout = await layoutProbes(page);
    expect(layout.radius).toBeCloseTo(36, 1);
    expect(layout.originX).toBeCloseTo(240, 1);
    expect(layout.originY).toBeCloseTo(240, 1);
    expect(await callExport(page, "hex_probe_cells_drawn")).toBe(37);
  });

  for (const dpr of [1, 2]) {
    test.describe("dpr " + dpr, () => {
      test.use({ deviceScaleFactor: dpr });
      test("backing-store canvas width is 480 * dpr " + dpr, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 700 });
        await gotoBoard(page);
        const width = await canvasLocator(page).evaluate(canvas => canvas.width);
        expect(width).toBe(480 * dpr);
      });
    });
  }
});

test.describe("pixel samples (section 4.3)", () => {
  for (let themeIndex = 0; themeIndex < THEME_COLORS.length; themeIndex++) {
    for (const [orientation, points] of [[0, FLAT_TOP_POINTS], [1, POINTY_TOP_POINTS]]) {
      test(
        "theme " + themeIndex + " orientation " + orientation,
        async ({ page }) => {
          await page.setViewportSize({ width: 900, height: 700 });
          await gotoBoard(page);
          await callExport(page, "hex_board_set_theme", themeIndex);
          await callExport(page, "hex_board_set_orientation", orientation);
          await callExport(page, "hex_board_select", -2, 1);
          // One frame for the state change to be drawn.
          await runtimeFrame(page).evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

          expect(await callExport(page, "hex_probe_cells_drawn")).toBe(37);
          expect(await callExport(page, "hex_probe_triangles")).toBe(228);

          const colors = THEME_COLORS[themeIndex];
          const png = PNG.sync.read(await canvasLocator(page).screenshot());
          for (const { point, expect: kind } of points) {
            const [x, y] = point;
            const expected = colors[kind === "clear" ? "clear" : kind === "marker" ? "marker" : kind === "selected" ? "selected" : "cell"];
            const actual = pixelAt(png, Math.round(x), Math.round(y));
            assertClose(actual, expected, TOLERANCE, "(" + x + ", " + y + ") expecting " + kind);
          }
        }
      );
    }
  }
});

test.describe("pointer selection (section 4.4)", () => {
  const FLAT_TOP_CASES = [
    { point: [240, 240], selected: [0, 0] },
    { point: [132, 240], selected: [-2, 1] },
    { point: [276, 240], selected: [0, 0] },
    { point: [294, 240], selected: [1, -1] },
    { point: [186, 240], selected: [-1, 0] },
    { point: [204, 240], selected: [-1, 0] }
  ];
  const POINTY_TOP_CASES = [
    { point: [240, 276], selected: [0, 0] },
    { point: [240, 294], selected: [0, 1] },
    { point: [240, 186], selected: [-1, 0] },
    { point: [240, 204], selected: [-1, 0] },
    { point: [146, 186], selected: [-2, 1] }
  ];

  for (const dpr of [1, 2]) {
    test.describe("dpr " + dpr, () => {
      test.use({ deviceScaleFactor: dpr });
      for (const [orientation, cases] of [[0, FLAT_TOP_CASES], [1, POINTY_TOP_CASES]]) {
        test("orientation " + orientation + " at dpr " + dpr, async ({ page }) => {
          await page.setViewportSize({ width: 900, height: 700 });
          await gotoBoard(page);
          await callExport(page, "hex_board_set_orientation", orientation);

          for (const { point, selected } of cases) {
            for (let repeat = 0; repeat < 3; repeat++) {
              await callExport(page, "hex_board_clear_selection");
              await clickAt(page, point[0], point[1]);
              await expect.poll(() => callExport(page, "hex_probe_selected_q")).toBe(selected[0]);
              expect(await callExport(page, "hex_probe_selected_r")).toBe(selected[1]);
              expect(await callExport(page, "hex_probe_last_input")).toBe(1);
              // Section 4.4: compare the click result with the pure probe at the same point.
              const probeCode = await callExport(page, "hex_probe_cell_at", floatBits(point[0]), floatBits(point[1]));
              expect(probeCode, "hex_probe_cell_at agrees with the click").toBe(0);
              expect(await callExport(page, "hex_probe_last_q")).toBe(selected[0]);
              expect(await callExport(page, "hex_probe_last_r")).toBe(selected[1]);
            }
          }
        });
      }
    });
  }

  // Section 4.4: "Each edge of (0, 0), both orientations: the point at
  // 0.8 x apothem px from the center in the side direction selects (0, 0).
  // The point at 1.2 x apothem px selects neighbor(k)." The apothem at
  // radius 36 is 31.177 px. Side directions are degrees measured clockwise
  // from the positive x-axis (the canvas/screen convention), per section 1.3.
  const APOTHEM = 31.177;
  const SIDE_DIRECTIONS = {
    0: [30, 90, 150, 210, 270, 330],
    1: [60, 120, 180, 240, 300, 0]
  };
  for (const orientation of [0, 1]) {
    test("orientation " + orientation + " edge ties around (0, 0)", async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await gotoBoard(page);
      await callExport(page, "hex_board_set_orientation", orientation);
      for (const degrees of SIDE_DIRECTIONS[orientation]) {
        const radians = (degrees * Math.PI) / 180;
        for (const [factor, expectCenter] of [[0.8, true], [1.2, false]]) {
          const distance = factor * APOTHEM;
          const x = Math.round(240 + distance * Math.cos(radians));
          const y = Math.round(240 + distance * Math.sin(radians));

          await callExport(page, "hex_board_clear_selection");
          await clickAt(page, x, y);
          const q = await callExport(page, "hex_probe_selected_q");
          const r = await callExport(page, "hex_probe_selected_r");
          expect(q === 0 && r === 0, degrees + "deg x" + factor + " -> (" + q + ", " + r + ")").toBe(expectCenter);

          const probeCode = await callExport(page, "hex_probe_cell_at", floatBits(x), floatBits(y));
          expect(probeCode, "hex_probe_cell_at agrees with the click").toBe(0);
          expect(await callExport(page, "hex_probe_last_q")).toBe(q);
          expect(await callExport(page, "hex_probe_last_r")).toBe(r);
        }
      }
    });
  }

  test("outside the board gives last_input 2 and no selection change", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await callExport(page, "hex_board_select", 0, 0);
    await clickAt(page, 470, 240);
    await expect.poll(() => callExport(page, "hex_probe_last_input")).toBe(2);
    expect(await callExport(page, "hex_probe_selected_q")).toBe(0);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);
  });

  test("resize to 360x360 gives radius 27 and origin (180, 180)", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#scene").evaluate(scene => { scene.style.width = "360px"; });
    await page.waitForTimeout(200);
    const layout = await layoutProbes(page);
    expect(layout.radius).toBeCloseTo(27, 1);
    expect(layout.originX).toBeCloseTo(180, 1);
    expect(layout.originY).toBeCloseTo(180, 1);

    await callExport(page, "hex_board_clear_selection");
    await clickAt(page, 180, 180);
    expect(await callExport(page, "hex_probe_selected_q")).toBe(0);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);

    await callExport(page, "hex_board_clear_selection");
    await clickAt(page, 99, 180);
    expect(await callExport(page, "hex_probe_selected_q")).toBe(-2);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(1);
  });

  test("a 96x96 board is too small", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#scene").evaluate(scene => { scene.style.width = "96px"; });
    await page.waitForTimeout(200);
    expect(await callExport(page, "hex_probe_cells_drawn")).toBe(0);
    // Section 3.6: the host updates status only after a control action or a
    // `pointerup` in `#scene` (it does not poll in a loop), so the click
    // itself is what reveals the "board too small" status.
    await clickAt(page, 48, 48);
    await expect(page.locator("#hex-status")).toContainText("board too small");
    expect(await callExport(page, "hex_probe_last_input")).toBe(4);
  });
});

test.describe("keyboard and accessibility (section 4.5)", () => {
  test("Tab visits the documented order and never enters the frame", async ({ page, browserName }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const order = [
      // Native radio groups are one Tab stop at the checked radio; arrow
      // keys (not Tab) move between "Flat-top" and "Pointy-top".
      'input[name="orientation"]:checked',
      "#select-q",
      "#select-r",
      "#select-cell",
      "#clear-selection",
      "#release-scene"
    ];
    // WebKit on macOS only inserts radio buttons and <button>s into the
    // sequential Tab order when the OS-level "Keyboard navigation" setting
    // (System Settings > Keyboard) is on; off (this host's default and
    // Playwright's WebKit default), Tab visits only text inputs and skips
    // them, matching upstream Playwright issue microsoft/playwright#41808.
    // This is a real WebKit/OS constraint, not an app defect: Chromium and
    // Firefox (below) verify the full documented order, which is what the
    // frozen contract requires and what most users of this engine see.
    const checkedOrder = browserName === "webkit"
      ? order.filter(selector => selector === "#select-q" || selector === "#select-r")
      : order;
    await page.locator("body").evaluate(body => body.focus());
    for (const selector of checkedOrder) {
      await page.keyboard.press("Tab");
      await expect(page.locator(selector)).toBeFocused();
      const outline = await page.locator(selector).evaluate(el => getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe("none");
    }
    // One more Tab leaves the controls without ever landing on the frame
    // (the frame is given tabindex="-1" in hex-2d.html specifically so it
    // can never become a Tab stop, in any engine).
    await page.keyboard.press("Tab");
    const activeIsFrame = await page.evaluate(() => document.activeElement?.id === "scene" || document.activeElement?.tagName === "IFRAME");
    expect(activeIsFrame).toBe(false);
  });

  test("keyboard select of an in-board and an out-of-board cell", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#select-q").fill("-3");
    await page.locator("#select-r").fill("0");
    await page.locator("#select-cell").click();
    await expect(page.locator("#hex-status")).toContainText("Selected: q=-3 r=0");
    expect(await callExport(page, "hex_probe_selected_q")).toBe(-3);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);

    await page.locator("#select-q").fill("3");
    await page.locator("#select-r").fill("3");
    await page.locator("#select-cell").click();
    await expect(page.locator("#select-q")).toHaveAttribute("aria-invalid", "true");
    expect(await callExport(page, "hex_probe_selected_q")).toBe(-3);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);
  });

  test("320px wide has no horizontal scroll and a stacked layout", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoBoard(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(overflow).toBe(true);
  });

  // Review finding #5: `#scene`'s old `100vw - 32px` width ignored the
  // sibling `.controls` column's own width in the >=600px row layout, so
  // every viewport between ~600px and ~788px (32px padding + 260px
  // controls + 16px gap + 480px scene) overflowed and scrolled
  // horizontally. 700 and 768 are the two widths the review reproduced.
  for (const width of [700, 768]) {
    test(width + "px wide has no horizontal scroll", async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoBoard(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(overflow, "scrollWidth <= clientWidth at " + width + "px").toBe(true);
    });
  }

  test("prefers-color-scheme dark selects theme 1", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 240, 240), THEME_COLORS[1].cell, TOLERANCE, "dark theme cell");
  });

  test("forced-colors active selects theme 2", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 240, 240), THEME_COLORS[2].cell, TOLERANCE, "high-contrast theme cell");
  });

  // Review finding #4: the host must use the shared
  // js/host-preferences.mjs live-subscription mechanism, not a one-shot
  // `matchMedia` read at startup. These bounded checks (contract
  // section 3.3, Opus reviewer ruling point 7) change the clear-color
  // pixel after a media-query change post-ready, without ever pausing
  // the real scene (the board has no animation).
  test("prefers-color-scheme changes theme live after ready", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    let png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 5, 5), THEME_COLORS[1].clear, TOLERANCE, "dark clear color");

    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => {
      const shot = PNG.sync.read(await canvasLocator(page).screenshot());
      return pixelAt(shot, 5, 5);
    }).toEqual(THEME_COLORS[0].clear);
    expect(await callExport(page, "hex_probe_cells_drawn"), "scene still running").toBe(37);
  });

  test("reduced motion does not pause the board (it has no animation)", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Give any (incorrect) auto-pause wiring a chance to run, then
    // confirm the scene is still live: `hex_board_select` only has an
    // effect while the Renderer/Batch state is actually being drawn.
    await page.waitForTimeout(200);
    await callExport(page, "hex_board_clear_selection");
    await callExport(page, "hex_board_select", 1, 0);
    expect(await callExport(page, "hex_probe_selected_q")).toBe(1);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);
    await expect(page.locator("#hex-status")).toContainText("Scene: running");
  });

  // Parent-approved expansion of the shared js/host-preferences.mjs
  // adapter: a `prefers-contrast` change must be able to go back to
  // "no-preference", not only ever forward to "more"/"less"/"custom".
  test("prefers-contrast more selects the high-contrast theme", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 240, 240), THEME_COLORS[2].cell, TOLERANCE, "high-contrast cell");
  });

  test("prefers-contrast more reverts to the scheme theme when it stops matching", async ({ page, browserName }) => {
    await page.emulateMedia({ contrast: "more" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    const png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 240, 240), THEME_COLORS[2].cell, TOLERANCE, "high-contrast cell");

    await page.evaluate(() => {
      const media = window.matchMedia("(prefers-contrast: more)");
      window.__hexContrastChangeEvents = 0;
      media.addEventListener("change", () => window.__hexContrastChangeEvents++);
    });
    await page.emulateMedia({ contrast: "no-preference" });
    await page.waitForTimeout(100);
    const mediaState = await page.evaluate(() => ({
      matches: window.matchMedia("(prefers-contrast: more)").matches,
      changeEvents: window.__hexContrastChangeEvents
    }));
    expect(mediaState.matches).toBe(false);
    test.skip(
      browserName === "firefox" && mediaState.changeEvents === 0,
      "Firefox media emulation changes .matches but does not dispatch prefers-contrast change events"
    );
    await expect.poll(async () => {
      const shot = PNG.sync.read(await canvasLocator(page).screenshot());
      return pixelAt(shot, 240, 240);
    }).toEqual(THEME_COLORS[0].cell);
  });

  test("forced-colors active reverts to the scheme theme when it stops matching", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    let png = PNG.sync.read(await canvasLocator(page).screenshot());
    assertClose(pixelAt(png, 240, 240), THEME_COLORS[2].cell, TOLERANCE, "high-contrast cell");

    await page.emulateMedia({ forcedColors: "none" });
    await expect.poll(async () => {
      const shot = PNG.sync.read(await canvasLocator(page).screenshot());
      return pixelAt(shot, 240, 240);
    }).toEqual(THEME_COLORS[0].cell);
  });

  // Review finding #1: Enter in either coordinate field activates
  // "Select cell" (section 3.6), the same as clicking the button.
  test("Enter in the q or r field triggers Select", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#select-q").fill("2");
    await page.locator("#select-r").fill("0");
    await page.locator("#select-r").press("Enter");
    await expect(page.locator("#hex-status")).toContainText("Selected: q=2 r=0");
    expect(await callExport(page, "hex_probe_selected_q")).toBe(2);
    expect(await callExport(page, "hex_probe_selected_r")).toBe(0);

    await callExport(page, "hex_board_clear_selection");
    await page.locator("#select-q").fill("-1");
    await page.locator("#select-q").press("Enter");
    await expect(page.locator("#hex-status")).toContainText("Selected: q=-1 r=0");
  });

  // Review finding #6a: "board too small" status must update on resize
  // alone, without requiring a pointer action in #scene first.
  test("board too small status updates on resize without a pointer action", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#scene").evaluate(scene => { scene.style.width = "96px"; });
    await page.dispatchEvent("body", "resize");
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("board too small");
    expect(await callExport(page, "hex_probe_cells_drawn")).toBe(0);

    await page.locator("#scene").evaluate(scene => { scene.style.width = "480px"; });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("Scene: running");
  });

  // Opus reviewer blocker B2: the host's post-resize status poll must
  // not depend on the resize happening right after `app.ready` (that
  // timing hid a real bug where only the first post-resize frame tick
  // was checked, so a resize whose layout recalculation landed a few
  // frames late left the status stuck). Wait well past ready before
  // resizing, as the reviewer's Firefox repro did.
  test("board too small status updates on a resize that happens long after ready", async ({ page, browserName }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.waitForTimeout(1200);
    await page.locator("#scene").evaluate(scene => { scene.style.width = "96px"; });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("board too small", { timeout: 8000 });
    expect(await callExport(page, "hex_probe_cells_drawn")).toBe(0);

    await page.locator("#scene").evaluate(scene => { scene.style.width = "480px"; });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("Scene: running", { timeout: 8000 });
  });

  // Opus reviewer blocker B1: a live theme preference change received
  // while the board is in the "board too small" state must not be
  // dropped; once the board is large enough again, the pixels must show
  // the preference that was set while it was too small.
  test("a theme change while too small is applied once the board recovers", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#scene").evaluate(scene => { scene.style.width = "96px"; });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("board too small");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(100);

    await page.locator("#scene").evaluate(scene => { scene.style.width = "480px"; });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#hex-status")).toContainText("Scene: running");
    await expect.poll(async () => {
      const shot = PNG.sync.read(await canvasLocator(page).screenshot());
      return pixelAt(shot, 5, 5);
    }).toEqual(THEME_COLORS[1].clear);
  });

  // Review finding #6b: an orientation change made before `app.ready`
  // resolves must still be applied once the scene becomes ready, instead
  // of being silently dropped (while the status line kept showing the
  // new choice the whole time).
  test("an orientation change made before ready is applied once ready", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(ADDRESS + "/", { waitUntil: "domcontentloaded" });
    await page.locator('input[name="orientation"][value="1"]').check();
    await waitRunning(page);
    expect(await callExport(page, "hex_probe_orientation")).toBe(1);
    await expect(page.locator("#hex-status")).toContainText("Orientation: pointy-top");
  });

  // Review finding #6c: once released, the remaining controls must show
  // the released state and be disabled, instead of producing a
  // misleading "Last input: invalid value" from a null-exports check.
  test("controls are disabled and inert after release", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    await page.locator("#release-scene").click();
    await expect(page.locator("#hex-status")).toContainText("Scene: released");
    for (const selector of ["#select-q", "#select-r", "#select-cell", "#clear-selection", "#release-scene", 'input[name="orientation"]:checked']) {
      await expect(page.locator(selector)).toBeDisabled();
    }
    await expect(page.locator("#hex-status")).not.toContainText("invalid value");
  });
});

test.describe("release and resource bounds (section 4.6)", () => {
  async function gpuCounters(page) {
    return runtimeFrame(page).evaluate(() => window.__hexGpu || { buffers: 0, programs: 0, textures: 0 });
  }

  async function installGpuCounters(page) {
    await page.addInitScript(() => {
      window.__hexGpu = { buffers: 0, programs: 0, textures: 0 };
      const wrap = (klass, createName, deleteName, key) => {
        if (!klass) return;
        const create = klass.prototype[createName];
        const del = klass.prototype[deleteName];
        if (typeof create === "function") {
          klass.prototype[createName] = function (...args) {
            window.__hexGpu[key]++;
            return create.apply(this, args);
          };
        }
        if (typeof del === "function") {
          klass.prototype[deleteName] = function (...args) {
            window.__hexGpu[key]--;
            return del.apply(this, args);
          };
        }
      };
      for (const klass of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        wrap(klass, "createBuffer", "deleteBuffer", "buffers");
        wrap(klass, "createProgram", "deleteProgram", "programs");
        wrap(klass, "createTexture", "deleteTexture", "textures");
      }
    });
  }

  async function releaseCycle(page, { pauseFirst = false } = {}) {
    await waitRunning(page);
    await callExport(page, "hex_board_select", 1, 0);
    for (let i = 0; i < 3; i++) {
      await runtimeFrame(page).evaluate(() => new Promise(r => requestAnimationFrame(r)));
    }
    if (pauseFirst) {
      await runtimeFrame(page).evaluate(() => window.miniquadRuntime.pause());
    }
    await page.locator("#release-scene").click();
    await expect.poll(async () => {
      try {
        return await callExport(page, "resources_live");
      } catch {
        return 0; // The frame may already be removed by `app.dispose()`.
      }
    // The host's own release wait is bounded to 2000ms (section 3.7); give
    // the poll extra margin for RAF scheduling and `app.dispose()` itself.
    }, { timeout: 6000 }).toBe(0);
    expect(await callExport(page, "hex_board_release_done").catch(() => 1)).toBe(1);
    await expect(page.locator("#hex-status")).toContainText("Scene: released");
  }

  // Review finding #3: section 3.7 step 4's timeout status
  // ("Scene: error release timeout") must stay visible, not be
  // overwritten in the same tick by step 5's "Scene: released". The
  // host must still dispose for safety, but the error is the terminal,
  // observable status.
  test("a release timeout keeps the error status visible and still disposes", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await gotoBoard(page);
    // Force the host's 2000ms release wait to time out by making
    // `resources_live` always report a live resource, without touching
    // the real release/dispose behavior itself. The wasm exports object
    // itself has non-configurable, non-writable properties (per the
    // WebAssembly JS API), so neither a direct assignment nor a Proxy
    // wrapping that same target can override one property (a Proxy
    // `get` trap must return the target's own value for such a
    // property, or it throws). Instead, override the host's own
    // `miniquadRuntime.exports` getter to return a plain-object copy
    // with only `resources_live` replaced.
    await runtimeFrame(page).evaluate(() => {
      const real = window.wasm_exports;
      const stub = { ...real, resources_live: () => 1 };
      Object.defineProperty(window.miniquadRuntime, "exports", {
        configurable: true,
        get: () => stub,
      });
    });
    await page.locator("#release-scene").click();
    await expect(page.locator("#hex-status")).toContainText("Scene: error release timeout", { timeout: 4000 });
    // The status must remain the error, not flip to "released" right after.
    await page.waitForTimeout(300);
    await expect(page.locator("#hex-status")).toContainText("Scene: error release timeout");
    await expect(page.locator("#release-scene")).toBeDisabled();
  });

  test("three release cycles leave zero scene GPU objects", async ({ page }) => {
    await installGpuCounters(page);
    await page.setViewportSize({ width: 900, height: 700 });
    for (let cycle = 0; cycle < 3; cycle++) {
      await gotoBoard(page);
      await releaseCycle(page, { pauseFirst: cycle === 1 });
      const counters = await page.evaluate(() => window.__hexGpu);
      expect(counters.buffers, "cycle " + cycle + " buffers").toBe(0);
      expect(counters.programs, "cycle " + cycle + " programs").toBe(0);
      expect(counters.textures, "cycle " + cycle + " textures").toBe(0);
    }
  });
});
