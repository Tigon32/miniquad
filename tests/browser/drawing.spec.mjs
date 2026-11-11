// Browser qualification for the optional `miniquad-draw` companion.
// Uses either the main browser fixture or the isolated comparison fixture.
import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

const GL_OBJECT_KINDS = ["Buffer", "Shader", "Program"];

// Tracks live GL object identity (not just call counts), via
// page.addInitScript so the wrapper is in place before the runtime's
// first gl.create* call in a fresh document.
function installGlTracking() {
    const live = {};
    const counts = { create: {}, delete: {} };
    for (const kind of ["Buffer", "Shader", "Program"]) {
        live[kind] = new Set();
        counts.create[kind] = 0;
        counts.delete[kind] = 0;
    }
    const duplicateOrUnknownDeletes = [];
    window.__glTracking = {
        snapshot() {
            const liveSizes = {};
            for (const kind of Object.keys(live)) liveSizes[kind] = live[kind].size;
            return {
                live: liveSizes,
                create: { ...counts.create },
                delete: { ...counts.delete },
                duplicateOrUnknownDeletes: duplicateOrUnknownDeletes.length,
            };
        },
    };
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
        if (!proto) continue;
        for (const kind of ["Buffer", "Shader", "Program"]) {
            const createName = "create" + kind;
            const deleteName = "delete" + kind;
            const originalCreate = proto[createName];
            if (typeof originalCreate === "function" && !originalCreate.__glTrackingWrapped) {
                const wrapped = function (...args) {
                    const obj = originalCreate.apply(this, args);
                    if (obj) {
                        live[kind].add(obj);
                        counts.create[kind] += 1;
                    }
                    return obj;
                };
                wrapped.__glTrackingWrapped = true;
                proto[createName] = wrapped;
            }
            const originalDelete = proto[deleteName];
            if (typeof originalDelete === "function" && !originalDelete.__glTrackingWrapped) {
                const wrapped = function (obj, ...rest) {
                    if (obj && live[kind].has(obj)) {
                        live[kind].delete(obj);
                        counts.delete[kind] += 1;
                    } else if (obj) {
                        duplicateOrUnknownDeletes.push(kind);
                    }
                    return originalDelete.call(this, obj, ...rest);
                };
                wrapped.__glTrackingWrapped = true;
                proto[deleteName] = wrapped;
            }
        }
    }
}

async function mountShowcase(page) {
    await page.goto("/drawing-qualification");
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

async function callExport(page, name, ...args) {
    return page.evaluate(
        ([name, args]) => window.app.frame.contentWindow.miniquadRuntime.exports[name](...args),
        [name, args],
    );
}

function readRGBA(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

async function screenshotCanvas(page) {
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    return PNG.sync.read(await canvas.screenshot());
}

function distinctColorCount(image) {
    const colors = new Set();
    for (let i = 0; i < image.data.length; i += 4) {
        colors.add(image.data.subarray(i, i + 4).toString("hex"));
    }
    return colors.size;
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
        expect(distinctColorCount(image), "The scene must contain more than a clear color").toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("resizes the canvas to its physical (DPR-scaled) pixel dimensions", async ({ page }, testInfo) => {
        const errors = collectErrors(page);
        const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
        await mountShowcase(page);
        await page.evaluate(() => {
            const scene = document.querySelector("#scene");
            scene.style.width = "320px";
            scene.style.height = "200px";
        });
        const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
        await expect(canvas).toHaveJSProperty("width", Math.round(320 * dpr));
        await expect(canvas).toHaveJSProperty("height", Math.round(200 * dpr));
        const image = await screenshotCanvas(page);
        expect(distinctColorCount(image), "The resized scene must still contain more than a clear color").toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });

    test("draws a persistent empty batch, verified by a processed-frame counter", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);
        await callExport(page, "request_empty_frame");
        await expect
            .poll(() => callExport(page, "empty_frames_processed"), { message: "empty_frames_processed must advance past zero" })
            .toBeGreaterThan(0);
        const processedAfterFirstPoll = await callExport(page, "empty_frames_processed");
        await expect
            .poll(() => callExport(page, "empty_frames_processed"), { message: "frames must keep advancing while empty" })
            .toBeGreaterThan(processedAfterFirstPoll);

        const image = await screenshotCanvas(page);
        // Stable empty mode: no shape is ever drawn, so every pixel must
        // equal the clear color (0.08, 0.08, 0.1) within rounding.
        expect(distinctColorCount(image), "An empty-batch frame must be clear-only (one color)").toBe(1);
        const pixel = readRGBA(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
        expect(Math.abs(pixel[0] - 20), "clear red channel").toBeLessThanOrEqual(2);
        expect(Math.abs(pixel[1] - 20), "clear green channel").toBeLessThanOrEqual(2);
        expect(Math.abs(pixel[2] - 26), "clear blue channel").toBeLessThanOrEqual(2);
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
        // comfortably inside each half, away from the clip boundary and
        // swatch edges.
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
        // A flat interior pixel, not an antialiased edge: tolerance covers
        // only 8-bit rounding/premultiplied-alpha rounding error, not an
        // edge allowance.
        const tolerance = 2;
        expect(Math.abs(pixel[0] - expectedR), "blended red channel").toBeLessThanOrEqual(tolerance);
        expect(Math.abs(pixel[1] - expectedG), "blended green channel").toBeLessThanOrEqual(tolerance);
        expect(Math.abs(pixel[2] - expectedB), "blended blue channel").toBeLessThanOrEqual(tolerance);
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
        await page.addInitScript(installGlTracking);
        await mountShowcase(page);

        const snapshot = () =>
            page.evaluate(() => document.querySelector("#scene iframe").contentWindow.__glTracking.snapshot());

        const liveBefore = await callExport(page, "resources_live");
        expect(liveBefore, "resources_live must report live before release").toBe(1);
        const before = await snapshot();
        // The renderer owns exactly one program and two buffers (vertex +
        // index) at steady state (companions/draw/src/gpu.rs); buffer
        // growth deletes the old buffer before creating a bigger one, so
        // the *live* count never exceeds this even mid-growth. No shader
        // object should ever be live: load_shader_internal deletes both
        // shader objects immediately after a successful link.
        expect(before.live.Program, "exactly one live GL program before release").toBe(1);
        expect(before.live.Buffer, "exactly two live GL buffers before release").toBe(2);
        expect(before.live.Shader, "no live GL shader objects (deleted at link time)").toBe(0);
        expect(before.duplicateOrUnknownDeletes, "no duplicate or unknown GL deletes yet").toBe(0);

        await callExport(page, "request_gpu_release");
        await expect
            .poll(() => callExport(page, "resources_live"), { message: "resources_live must settle to 0 after release" })
            .toBe(0);

        const after = await snapshot();
        for (const kind of GL_OBJECT_KINDS) {
            expect(after.live[kind], `every live ${kind} must be released`).toBe(0);
            expect(after.create[kind], `every created ${kind} must be deleted`).toBe(after.delete[kind]);
        }
        expect(after.create.Program, "no new program may be created by release itself").toBe(before.create.Program);
        expect(after.duplicateOrUnknownDeletes, "no duplicate or unknown GL deletes").toBe(0);

        // A second request must stay a no-op (idempotent): frames keep
        // advancing (not frozen), but nothing in the GL tracking changes.
        const framesBeforeSecond = await page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.frames);
        await callExport(page, "request_gpu_release");
        await expect
            .poll(() => page.evaluate(() => window.app.frame.contentWindow.miniquadRuntime.frames), {
                message: "frames must keep advancing after an idempotent release request",
            })
            .toBeGreaterThan(framesBeforeSecond);
        const final = await snapshot();
        expect(final, "a second release request must not change any GL tracking state").toEqual(after);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });
});

for (const expectedRatio of [1, 2]) {
test.describe(`device pixel ratio ${expectedRatio}`, () => {
    test.use({ deviceScaleFactor: expectedRatio });
    test("renders a high-DPI framebuffer at the configured device pixel ratio", async ({ page }) => {
        const errors = collectErrors(page);
        await mountShowcase(page);

        const ratio = await page.evaluate(() => window.app.frame.contentWindow.devicePixelRatio);
        expect(ratio, "devicePixelRatio inside the runtime iframe must match the configured project ratio").toBe(expectedRatio);

        const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
        const cssWidth = await canvas.evaluate(element => element.clientWidth);
        const cssHeight = await canvas.evaluate(element => element.clientHeight);
        await expect(canvas, "canvas physical width must equal CSS width * DPR").toHaveJSProperty(
            "width",
            Math.round(cssWidth * ratio),
        );
        await expect(canvas, "canvas physical height must equal CSS height * DPR").toHaveJSProperty(
            "height",
            Math.round(cssHeight * ratio),
        );

        const image = await screenshotCanvas(page);
        expect(image.width, "the captured framebuffer must be the physical (scaled) width").toBe(Math.round(cssWidth * ratio));
        expect(distinctColorCount(image), `DPR ${ratio} scene must contain more than a clear color`).toBeGreaterThan(8);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.app.dispose());
    });
});
}
