// Browser proof for the offline hex-voxel slice (issue #131, contract
// section 3.4). Runs against the private port-4290 harness in
// `experiments/hex-browser/` (see `playwright.config.mjs` there).
//
// Honesty notes (contract section 3 "honest measurements"):
//   - This file records only measurements it can actually take on
//     this server (port 4290, hex scene only). It does not fetch or
//     navigate to the parent-owned cubic server (port 4173/4174) to
//     avoid cross-tree coupling; the cubic-side half of any
//     cubic-vs-hex comparison is left `null` with a stated reason,
//     never fabricated or guessed.
//   - No pixel-parity or performance-promotion claim is made between
//     cubic and hex: the two meshers produce different geometry, so
//     a lower/higher number on one side is not asserted to mean
//     "better".
//   - Raw measurement JSON uses an ignored output directory or an
//     explicit artifact directory, never `tests/browser/`.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
    CAMERA,
    hexCellCenter,
    hexCellCorners,
    projectToPixel
} from "../camera-math.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const rawArtifactDir =
    process.env.HEX_BROWSER_ARTIFACT_DIR ||
    path.join(repoRoot, "test-results/hex-browser/measurements");
fs.mkdirSync(rawArtifactDir, { recursive: true });

const VIEWPORT_CSS = { width: 640, height: 360 };
const CLEAR_COLOR = [16, 24, 36]; // 0.063*255, 0.094*255, 0.141*255, rounded.

function isClearPixel(rgb, tolerance = 10) {
    return (
        Math.abs(rgb[0] - CLEAR_COLOR[0]) <= tolerance &&
        Math.abs(rgb[1] - CLEAR_COLOR[1]) <= tolerance &&
        Math.abs(rgb[2] - CLEAR_COLOR[2]) <= tolerance
    );
}

async function gotoVariant(page, variant) {
    await page.goto(`/?variant=${variant}`, { waitUntil: "load" });
    await page.waitForFunction(
        () =>
            typeof window.wasm_exports === "object" &&
            typeof window.wasm_exports.hex_probe_pick === "function" &&
            typeof window.gl === "object"
    );
    // Let the real GPU upload / first few frames settle before any
    // pixel or probe assertion (same convention as the cubic specs).
    await page.waitForTimeout(250);
}

function pixelBitsScript(px, py) {
    // Mirrors `tests/browser/hex-offline.html`'s pointerdown handler:
    // backing-store pixel coordinates reinterpreted as f32 bits.
    return `(() => {
        const pxBits = new Uint32Array(new Float32Array([${px}]).buffer)[0];
        const pyBits = new Uint32Array(new Float32Array([${py}]).buffer)[0];
        return window.wasm_exports.hex_probe_pick(pxBits, pyBits);
    })()`;
}

async function probePickAt(page, px, py) {
    await page.evaluate(pixelBitsScript(px, py));
    return page.evaluate(() => ({
        valid: window.wasm_exports.hex_probe_picked_valid(),
        q: window.wasm_exports.hex_probe_picked_q(),
        r: window.wasm_exports.hex_probe_picked_r(),
        layer: window.wasm_exports.hex_probe_picked_layer(),
        face: window.wasm_exports.hex_probe_picked_face()
    }));
}

// Fixed seed 20261111 gives these columns a highest solid layer of 3.
// No picker result is used to choose an expected cell.
const TOP_CELLS = [{ q: 2, r: 3, layer: 3 }, { q: -1, r: 1, layer: 3 }];

function topPixel(cell, viewportPixels) {
    const world = hexCellCenter(cell.q, cell.r, cell.layer);
    world[1] = cell.layer + 1;
    const pixel = projectToPixel(CAMERA, world, viewportPixels);
    expect(pixel).not.toBeNull();
    return pixel;
}

function colorAt(png, pixel) {
    const [x, y] = pixel.map(Math.floor);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(png.width);
    expect(y).toBeLessThan(png.height);
    const index = (png.width * y + x) * 4;
    return [...png.data.subarray(index, index + 3)];
}

function expectTopGrass(rgb) {
    const shade = 0.45 + 0.55 / Math.sqrt(0.4 ** 2 + 1 + 0.3 ** 2);
    for (const [channel, value] of [0.30, 0.65, 0.25].entries()) {
        expect(Math.abs(rgb[channel] - value * shade * 255)).toBeLessThanOrEqual(3);
    }
}

async function expectOuterSilhouette(page, viewportPixels) {
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(await page.locator("#glcanvas").screenshot());
    expect([png.width, png.height]).toEqual(viewportPixels);

    // This highest-layer corner and edge lie on the world exterior,
    // unlike an interior cell boundary with terrain on both sides.
    const cell = { q: -8, r: 0, layer: 3 };
    const corners = hexCellCorners(cell.q, cell.r, cell.layer);
    const center = topPixel(cell, viewportPixels);
    const vertex = projectToPixel(CAMERA, corners[10], viewportPixels);
    const next = projectToPixel(CAMERA, corners[11], viewportPixels);
    const midpoint = corners[10].map((value, i) => (value + corners[11][i]) * 0.5);
    const edge = projectToPixel(CAMERA, midpoint, viewportPixels);
    const radial = [vertex[0] - center[0], vertex[1] - center[1]];
    const normal = [next[1] - vertex[1], vertex[0] - next[0]];
    if (normal[0] * (edge[0] - center[0]) + normal[1] * (edge[1] - center[1]) < 0) {
        normal[0] *= -1;
        normal[1] *= -1;
    }
    for (const [point, direction] of [[vertex, radial], [edge, normal]]) {
        const length = Math.hypot(...direction);
        const inside = point.map((value, i) => value - 2 * direction[i] / length);
        const outside = point.map((value, i) => value + 2 * direction[i] / length);
        expectTopGrass(colorAt(png, inside));
        expect(isClearPixel(colorAt(png, outside), 2)).toBe(true);
    }
}

test.describe("offline hex-voxel scene: WebGL context types", () => {
    for (const [variant, expectWebgl2] of [
        ["webgl1", false],
        ["webgl2", true]
    ]) {
        test(`variant=${variant} actually creates a ${expectWebgl2 ? "WebGL2" : "WebGL1"} context`, async ({ page }) => {
            const errors = [];
            page.on("pageerror", error => errors.push(error.message));
            await gotoVariant(page, variant);
            const kind = await page.evaluate(() => {
                if (window.gl instanceof window.WebGL2RenderingContext) return "webgl2";
                if (window.gl instanceof window.WebGLRenderingContext) return "webgl1";
                return "unknown";
            });
            expect(kind).toBe(variant);
            expect(errors).toEqual([]);
        });
    }
});

test.describe("offline hex-voxel scene: analytic picking", () => {
    test("startup picking matches fixed highest-layer cells before any resize", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        for (const [q, r] of [[2, 3], [-1, 1]]) {
            const center = hexCellCenter(q, r, 3);
            center[1] = 4;
            const pixel = projectToPixel(CAMERA, center, [640, 360]);
            const canvas = page.locator("#glcanvas");
            const bounds = await canvas.boundingBox();
            await page.mouse.click(bounds.x + pixel[0], bounds.y + pixel[1]);
            const picked = await page.evaluate(() => ({
                valid: window.wasm_exports.hex_probe_picked_valid(),
                q: window.wasm_exports.hex_probe_picked_q(),
                r: window.wasm_exports.hex_probe_picked_r(),
                layer: window.wasm_exports.hex_probe_picked_layer(),
                face: window.wasm_exports.hex_probe_picked_face(),
            }));
            expect(picked).toEqual({ valid: 1, q, r, layer: 3, face: 6 });
        }
    });

    test("a fixed top-center selects the expected cell and face repeatedly", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        const viewportPixels = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];
        const cell = TOP_CELLS[0];
        const pixel = topPixel(cell, viewportPixels);
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = await probePickAt(page, pixel[0], pixel[1]);
            expect(result, `repeat ${attempt} must be deterministic`).toEqual({ valid: 1, ...cell, face: 6 });
        }
    });

    test("picking a cell in the negative-chunk-coordinate chunk (-1,0,0) returns a negative q coordinate", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        const viewportPixels = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];
        const cell = TOP_CELLS[1];
        const pixel = topPixel(cell, viewportPixels);
        expect(await probePickAt(page, ...pixel)).toEqual({ valid: 1, ...cell, face: 6 });
    });
});

test.describe("offline hex-voxel scene: silhouette and seam", () => {
    test("an exterior hex edge and vertex separate grass from clear pixels", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        await expectOuterSilhouette(page, [VIEWPORT_CSS.width, VIEWPORT_CSS.height]);
    });

    test("the q=-1|0 chunk seam has no background gap between the two resident chunks", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        const viewportPixels = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];
        const screenshot = await page.locator("#glcanvas").screenshot();
        const { PNG } = await import("pngjs");
        const png = PNG.sync.read(screenshot);
        const left = topPixel({ q: -1, r: 4, layer: 3 }, viewportPixels);
        const right = topPixel({ q: 0, r: 4, layer: 3 }, viewportPixels);
        for (let step = 0; step <= 16; step++) {
            const pixel = left.map((value, i) => value + step / 16 * (right[i] - value));
            expectTopGrass(colorAt(png, pixel));
        }
    });
});

test.describe("offline hex-voxel scene: device pixel ratio", () => {
    for (const variant of ["webgl1", "webgl2"]) {
      for (const dpr of [1, 2]) {
        test(`${variant}, DPR ${dpr}: backing size, real pointer picking, and exterior silhouette`, async ({ browser }) => {
            const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: VIEWPORT_CSS });
            const page = await context.newPage();
            try {
                await gotoVariant(page, variant);
                const backing = await page.evaluate(() => {
                    const canvas = document.querySelector("#glcanvas");
                    return { width: canvas.width, height: canvas.height };
                });
                expect(backing.width).toBe(VIEWPORT_CSS.width * dpr);
                expect(backing.height).toBe(VIEWPORT_CSS.height * dpr);

                const backingPixels = [backing.width, backing.height];
                const cell = TOP_CELLS[0];
                const pixel = topPixel(cell, backingPixels);
                const bounds = await page.locator("#glcanvas").boundingBox();
                await page.mouse.click(bounds.x + pixel[0] / dpr, bounds.y + pixel[1] / dpr);
                const result = await page.evaluate(() => ({
                    valid: window.wasm_exports.hex_probe_picked_valid(),
                    q: window.wasm_exports.hex_probe_picked_q(),
                    r: window.wasm_exports.hex_probe_picked_r(),
                    layer: window.wasm_exports.hex_probe_picked_layer(),
                    face: window.wasm_exports.hex_probe_picked_face(),
                }));
                expect(result).toEqual({ valid: 1, ...cell, face: 6 });
                await expectOuterSilhouette(page, backingPixels);
            } finally {
                await context.close();
            }
        });
      }
    }

    test("the fixed world cell is picked at the scaled backing-store position for DPR 1 and DPR 2", async ({ browser }) => {
        const cssViewport = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];
        const cell = TOP_CELLS[0];
        const pixel = topPixel(cell, cssViewport);

        const results = [];
        for (const dpr of [1, 2]) {
            const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: VIEWPORT_CSS });
            const page = await context.newPage();
            try {
                await gotoVariant(page, "webgl1");
                results.push(await probePickAt(page, pixel[0] * dpr, pixel[1] * dpr));
            } finally {
                await context.close();
            }
        }
        expect(results[0]).toEqual({ valid: 1, ...cell, face: 6 });
        expect(results[1]).toEqual({ valid: 1, ...cell, face: 6 });
    });
});

test.describe("offline hex-voxel scene: occlusion and world mutation", () => {
    test("Place column occludes the sprite's screen position with terrain color", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        const canvas = page.locator("#glcanvas");
        const viewportPixels = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];

        // PALETTE[2] (dirt, contract-material index for
        // PLACE_COLUMN_MATERIAL) scaled by the example's flat-shade
        // lighting range; a loose per-channel tolerance accepts any
        // in-range shade without claiming an exact lit value.
        const dirtPalette = [0.45 * 255, 0.33 * 255, 0.2 * 255];
        function looksLikeDirt(rgb, tol = 60) {
            return (
                Math.abs(rgb[0] - dirtPalette[0]) <= tol &&
                Math.abs(rgb[1] - dirtPalette[1]) <= tol &&
                Math.abs(rgb[2] - dirtPalette[2]) <= tol &&
                rgb[0] > rgb[2] // dirt is redder than it is blue; distinguishes it from the grass/stone palette entries.
            );
        }

        const { PNG } = await import("pngjs");
        async function colorAtPixel(pixel) {
            const png = PNG.sync.read(await canvas.screenshot());
            const cssToBacking = png.width / VIEWPORT_CSS.width;
            const x = Math.round(pixel[0] * cssToBacking);
            const y = Math.round(pixel[1] * cssToBacking);
            if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
            const i = (png.width * y + x) * 4;
            return [png.data[i], png.data[i + 1], png.data[i + 2]];
        }

        // Read the sprite's actual current world position (example-
        // only probes, not a core API change) and project the top of
        // the column that "Place column" is about to write, so the
        // before/after sample is honestly at the mutated pixel
        // instead of an assumed fixed point.
        const spriteX = await page.evaluate(() => {
            const bits = window.wasm_exports.hex_probe_sprite_x_bits();
            return new Float32Array(new Uint32Array([bits]).buffer)[0];
        });
        const spriteZ = await page.evaluate(() => {
            const bits = window.wasm_exports.hex_probe_sprite_z_bits();
            return new Float32Array(new Uint32Array([bits]).buffer)[0];
        });
        const spriteLayer = await page.evaluate(() => window.wasm_exports.hex_probe_sprite_layer());
        const columnTopY = (Math.min(spriteLayer, 3) + 1) * 1.0;
        const columnTopPixel = projectToPixel(CAMERA, [spriteX, columnTopY, spriteZ], viewportPixels);
        expect(columnTopPixel, "the sprite's current world position must project onto the viewport").not.toBeNull();

        const beforeColor = await colorAtPixel(columnTopPixel);
        expect(beforeColor, "the column-top pixel must be in-viewport before the click").not.toBeNull();
        const trianglesBefore = await page.evaluate(() => window.wasm_exports.hex_probe_triangles());

        await page.locator("#hex-place-column").click();
        await page.waitForTimeout(300);

        const afterColor = await colorAtPixel(columnTopPixel);
        const trianglesAfter = await page.evaluate(() => window.wasm_exports.hex_probe_triangles());

        // The column write is a hard overwrite to dirt regardless of
        // what was there before (contract: material identity, not
        // face count, is the only guaranteed-changed signal -- see
        // the code comment on `place_column_under_sprite`). Assert on
        // the rendered color, not on triangle count, which can
        // legitimately stay flat if the column was already fully
        // solid.
        expect(looksLikeDirt(afterColor), "the column-top pixel must be dirt-colored after Place column").toBe(true);
        expect(trianglesAfter, "Place column must never remove geometry").toBeGreaterThanOrEqual(trianglesBefore);
    });
});

test.describe("offline hex-voxel scene: idempotent release across mount cycles", () => {
    test("three mount/release cycles each reach resources_live()==0 with no unbounded growth", async ({ page }) => {
        const liveCounts = [];
        const createDeleteCounts = [];
        for (let cycle = 0; cycle < 3; cycle++) {
            await page.addInitScript(() => {
                window.__glCreateCount = 0;
                window.__glDeleteCount = 0;
                for (const klass of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
                    if (!klass?.prototype) continue;
                    for (const name of ["createBuffer", "createProgram"]) {
                        const original = klass.prototype[name];
                        if (!original || klass.prototype[name].__hexWrapped) continue;
                        klass.prototype[name] = function (...args) {
                            window.__glCreateCount++;
                            return original.apply(this, args);
                        };
                        klass.prototype[name].__hexWrapped = true;
                    }
                    for (const name of ["deleteBuffer", "deleteProgram"]) {
                        const original = klass.prototype[name];
                        if (!original || klass.prototype[name].__hexWrapped) continue;
                        klass.prototype[name] = function (...args) {
                            window.__glDeleteCount++;
                            return original.apply(this, args);
                        };
                        klass.prototype[name].__hexWrapped = true;
                    }
                }
            });
            await gotoVariant(page, "webgl1");
            const before = await page.evaluate(() => window.wasm_exports.resources_live());
            expect(before, `cycle ${cycle}: resources_live() must be nonzero before release`).toBeGreaterThan(0);

            await page.locator("#hex-release").click();
            await page.waitForTimeout(200);
            const after = await page.evaluate(() => window.wasm_exports.resources_live());
            expect(after, `cycle ${cycle}: resources_live() must reach 0 after release`).toBe(0);
            liveCounts.push({ cycle, before, after });

            const counts = await page.evaluate(() => ({
                created: window.__glCreateCount,
                deleted: window.__glDeleteCount
            }));
            createDeleteCounts.push(counts);
            // Real GL object identity tracking, not a claim of
            // immediate driver VRAM/GC release: only that every
            // object this example created this cycle was also
            // deleted exactly once by the end of the cycle.
            expect(counts.deleted, `cycle ${cycle}: every created GL object must be deleted`).toBe(counts.created);

            await page.reload();
        }
        fs.writeFileSync(
            path.join(rawArtifactDir, "release-cycles.json"),
            JSON.stringify({ liveCounts, createDeleteCounts }, null, 2)
        );
    });
});

test.describe("offline hex-voxel scene: downstream consumer crate", () => {
    test("the path-only downstream consumer crate builds and runs natively, and builds for wasm32", async () => {
        const { execFileSync } = await import("node:child_process");
        const cwd = path.join(repoRoot, "tests/hex-downstream-consumer");
        const env = process.env;

        const runOutput = execFileSync("cargo", ["run", "--quiet"], { cwd, env, encoding: "utf8" });
        expect(runOutput, "the downstream crate must produce real picker/geometry output, not a stub").toMatch(/picked q=/);
        expect(runOutput).toMatch(/built \d+ hex vertices/);

        execFileSync("cargo", ["build", "--quiet", "--target", "wasm32-unknown-unknown"], { cwd, env });
    });
});

test.describe("offline hex-voxel scene: honest measurements", () => {
    test("records real frame-interval percentiles, mesh stats, and gzip sizes for the hex scene only", async ({ page }, testInfo) => {
        await gotoVariant(page, "webgl1");

        const intervals = await page.evaluate(
            () =>
                new Promise(resolve => {
                    const samples = [];
                    let last = performance.now();
                    function tick() {
                        const now = performance.now();
                        samples.push(now - last);
                        last = now;
                        if (samples.length < 120) requestAnimationFrame(tick);
                        else resolve(samples.slice(1)); // drop the first (startup) sample.
                    }
                    requestAnimationFrame(tick);
                })
        );
        intervals.sort((a, b) => a - b);
        const percentile = p => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))];

        const triangles = await page.evaluate(() => window.wasm_exports.hex_probe_triangles());

        const wasmResponse = await page.request.get("/offline_hex_webgl1.wasm");
        const wasmBytes = Buffer.from(await wasmResponse.body());
        const jsBytes = fs.readFileSync(path.join(repoRoot, "js/gl.js"));

        const record = {
            scene: "hex",
            residentChunkCount: 2,
            cellCount: null,
            cellCountReason: "solid cells were not counted; resident chunks are not cells",
            seed: 20261111,
            browser: testInfo.project.name,
            browserVersion: page.context().browser()?.version() ?? null,
            os: process.platform,
            dpr: 1,
            canvas: VIEWPORT_CSS,
            frameIntervalMsP95: percentile(0.95),
            frameIntervalMsP99: percentile(0.99),
            frameIntervalSampleCount: intervals.length,
            triangleCount: triangles,
            wasmBytes: wasmBytes.length,
            wasmGzipBytes: zlib.gzipSync(wasmBytes).length,
            jsBytes: jsBytes.length,
            jsGzipBytes: zlib.gzipSync(jsBytes).length,
            cubicComparison: {
                available: false,
                reason:
                    "the cubic baseline lives on the parent-owned port 4173/4174 server; this isolated port-4290 tree does not navigate there, per the task's port-isolation constraint. No cubic number is fabricated: both sides of any cubic-vs-hex figure are left out rather than guessed.",
                vertices: null,
                indices: null,
                meshBuildTimeMs: null,
                frameIntervalMsP95: null,
                frameIntervalMsP99: null,
                wasmGzipBytes: null
            },
            gpuMetricsUnavailable: {
                vramBytes: null,
                reason: "WebGL exposes no portable VRAM/driver-memory query; not measured, not estimated."
            }
        };
        fs.writeFileSync(path.join(rawArtifactDir, "hex-measurement.json"), JSON.stringify(record, null, 2));

        expect(record.frameIntervalMsP95).toBeGreaterThan(0);
        expect(record.triangleCount).toBeGreaterThan(0);
        expect(record.wasmGzipBytes).toBeGreaterThan(0);
    });
});
