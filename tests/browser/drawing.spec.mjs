// Browser qualification for the optional `miniquad-draw` companion
// (issue #123). Runs against this session's own isolated harness
// (`experiments/drawing-comparison/serve-drawing.mjs` + its own
// `playwright.config.mjs`, port 4280) — never the parent's
// `tests/browser/serve.mjs` / root `playwright.config.mjs` (port 4173).
//
// Covers, with real measurements (not simulated):
//   - DPR 1 and DPR 2 rendering (non-trivial pixel content at both
//     scales, via the isolated config's per-project deviceScaleFactor).
//   - Resize.
//   - An empty batch (zero shapes) drawing without a crash or console
//     error.
//   - Clipping, opacity blending, and draw order, each asserted against
//     a flat *interior* pixel sampled away from any anti-aliased edge
//     (hard edges are a documented `miniquad-draw` limit, so pixel
//     parity is never claimed at a boundary).
//   - Real GPU buffer/shader/program create and delete counts, tied to
//     the showcase's exported `request_gpu_release` / `resources_live`
//     (companions/draw/examples/showcase.rs), confirming the companion
//     actually releases its GL objects once requested.
import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

// Installed once per test via `page.addInitScript`, which Playwright
// guarantees runs before any other script in every new document,
// including same-origin iframes — this is what lets the counters see
// the very first `gl.createBuffer`/`gl.createShader`/`gl.createProgram`
// calls the runtime makes on startup, not just calls made after the
// test script got a chance to attach a listener.
function installGlCounters() {
    const methods = ["createBuffer", "deleteBuffer", "createShader", "deleteShader", "createProgram", "deleteProgram"];
    window.__glCounts = Object.fromEntries(methods.map(name => [name, 0]));
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
        if (!proto) continue;
        for (const name of methods) {
            const original = proto[name];
            if (typeof original !== "function") continue;
            proto[name] = function (...args) {
                window.__glCounts[name] += 1;
                return original.apply(this, args);
            };
        }
    }
}

async function mountShowcase(page) {
    await page.goto("/qualification");
    await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        window.app = mount({
            container: document.querySelector("#scene"),
            wasmURL: "/drawing.wasm",
            title: "Drawing companion showcase",
        });
        await window.app.ready;
    });
    await page.waitForFunction(() => window.app.frame.contentWindow.miniquadRuntime.frames > 2);
}

function readRGBA(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

async function screenshotCanvas(page) {
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    return PNG.sync.read(await canvas.screenshot());
}

function collectErrors(page) {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
    });
    return errors;
}

test.describe("drawing companion qualification", () => {
    test("renders geometry through compiled WASM and reports more than a clear color", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        const image = await screenshotCanvas(page);
        const colors = new Set();
        for (let i = 0; i < image.data.length; i += 4) {
            colors.add(image.data.subarray(i, i + 4).toString("hex"));
        }
        expect(colors.size, "The scene must contain more than a clear color").toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("resizes the canvas and keeps drawing without console errors", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        await page.evaluate(() => {
            document.querySelector("#scene").style.width = "320px";
        });
        const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
        await expect(canvas).toHaveJSProperty("width", 320);
        const image = await screenshotCanvas(page);
        const colors = new Set();
        for (let i = 0; i < image.data.length; i += 4) {
            colors.add(image.data.subarray(i, i + 4).toString("hex"));
        }
        expect(colors.size, "The resized scene must still contain more than a clear color").toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("draws an empty batch without a crash or console error", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        await page.evaluate(() => {
            window.app.frame.contentWindow.miniquadRuntime.exports.request_empty_frame();
        });
        // Give the runtime a few frames to consume the one-shot empty
        // request and keep running afterward (not freeze or crash).
        await page.waitForTimeout(100);
        const framesBefore = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.frames);
        await page.waitForTimeout(100);
        const framesAfter = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.frames);
        expect(framesAfter, "The runtime must keep rendering frames after an empty batch").toBeGreaterThan(framesBefore);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("clips a shape to the requested rectangle", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        const image = await screenshotCanvas(page);
        const w = image.width;
        const h = image.height;
        // Panel at x in [0.72, 0.90] * width, y in [0.02, 0.10] * height
        // (companions/draw/examples/showcase.rs: draw_qc_panels). Sample
        // comfortably inside each half, away from the clip boundary at
        // x = 0.81 * width and the swatch edges.
        const left = readRGBA(image, Math.round(w * 0.74), Math.round(h * 0.06));
        const right = readRGBA(image, Math.round(w * 0.86), Math.round(h * 0.06));
        // Left half: clipped overlay color (orange, ~242,128,13).
        expect(left[0], "clipped region red channel").toBeGreaterThan(200);
        expect(left[1], "clipped region green channel").toBeGreaterThan(90);
        expect(left[2], "clipped region blue channel").toBeLessThan(60);
        // Right half: unaffected base color (teal, ~0,153,153).
        expect(right[0], "unclipped region red channel").toBeLessThan(40);
        expect(right[1], "unclipped region green channel").toBeGreaterThan(110);
        expect(right[2], "unclipped region blue channel").toBeGreaterThan(110);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("blends a translucent overlay over an opaque base (over compositing)", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        const image = await screenshotCanvas(page);
        const w = image.width;
        const h = image.height;
        // Panel at x in [0.72, 0.90] * width, y in [0.14, 0.22] * height:
        // opaque red (0.9,0.05,0.05) then 50%-alpha blue (0.05,0.05,0.9)
        // drawn "over" it. Expected ~= 0.5*blue + 0.5*red per channel.
        const pixel = readRGBA(image, Math.round(w * 0.81), Math.round(h * 0.18));
        const expectedR = Math.round(255 * (0.5 * 0.9 + 0.5 * 0.05));
        const expectedG = Math.round(255 * 0.05);
        const expectedB = Math.round(255 * (0.5 * 0.05 + 0.5 * 0.9));
        const tolerance = 24;
        expect(Math.abs(pixel[0] - expectedR), "blended red channel").toBeLessThan(tolerance);
        expect(Math.abs(pixel[1] - expectedG), "blended green channel").toBeLessThan(tolerance);
        expect(Math.abs(pixel[2] - expectedB), "blended blue channel").toBeLessThan(tolerance);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("draws later shapes over earlier ones at the same location (draw order)", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        const image = await screenshotCanvas(page);
        const w = image.width;
        const h = image.height;
        // Panel at x in [0.72, 0.90] * width, y in [0.26, 0.34] * height:
        // opaque green drawn first, opaque yellow drawn second over the
        // same rectangle. Only the yellow (last-drawn) color may show.
        const pixel = readRGBA(image, Math.round(w * 0.81), Math.round(h * 0.30));
        expect(pixel[0], "draw-order red channel (yellow, not green)").toBeGreaterThan(200);
        expect(pixel[1], "draw-order green channel").toBeGreaterThan(200);
        expect(pixel[2], "draw-order blue channel (must not be green's blue)").toBeLessThan(60);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("releases its GPU resources exactly once on request", async ({ page }) => {
        const errors = collectErrors(page);
        await page.addInitScript(installGlCounters);
        await mountShowcase(page);
        const liveBefore = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.resources_live());
        expect(liveBefore, "resources_live must report live before release").toBe(1);
        const countsBefore = await page.evaluate(() => {
            const frame = document.querySelector("#scene iframe");
            return frame.contentWindow.__glCounts;
        });
        // The renderer creates exactly one shader (program), one
        // pipeline (no GL object of its own), and two buffers (vertex +
        // index) at steady state — see companions/draw/src/gpu.rs. Grow
        // reallocation can create/delete more buffers before settling,
        // so assert only the floor that must hold from startup.
        expect(countsBefore.createProgram, "at least one GL program created on startup").toBeGreaterThanOrEqual(1);
        expect(countsBefore.createBuffer, "at least two GL buffers created on startup").toBeGreaterThanOrEqual(2);

        await page.evaluate(async () => {
            window.app.frame.contentWindow.miniquadRuntime.exports.request_gpu_release();
        });
        await page.waitForTimeout(150);
        const liveAfter = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.resources_live());
        expect(liveAfter, "resources_live must report released after request_gpu_release").toBe(0);

        const countsAfter = await page.evaluate(() => {
            const frame = document.querySelector("#scene iframe");
            return frame.contentWindow.__glCounts;
        });
        expect(countsAfter.deleteProgram, "the program must be deleted exactly once").toBe(1);
        expect(countsAfter.deleteBuffer, "every created buffer must be deleted").toBeGreaterThanOrEqual(countsBefore.createBuffer);
        expect(countsAfter.createProgram, "no new program may be created after release").toBe(countsBefore.createProgram);

        // A second request must stay a no-op (idempotent): counts and
        // the live flag must not change again.
        await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.exports.request_gpu_release());
        await page.waitForTimeout(150);
        const countsFinal = await page.evaluate(() => {
            const frame = document.querySelector("#scene iframe");
            return frame.contentWindow.__glCounts;
        });
        expect(countsFinal.deleteProgram, "a second release request must not delete again").toBe(1);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });
});

test.describe("device pixel ratio", () => {
    test("renders a non-trivial scene at the configured device pixel ratio", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        const ratio = await page.evaluate(() => window.app.frame.contentWindow.devicePixelRatio);
        expect(typeof ratio, "devicePixelRatio must be readable").toBe("number");
        const image = await screenshotCanvas(page);
        const colors = new Set();
        for (let i = 0; i < image.data.length; i += 4) {
            colors.add(image.data.subarray(i, i + 4).toString("hex"));
        }
        expect(colors.size, `DPR ${ratio} scene must contain more than a clear color`).toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });
});
