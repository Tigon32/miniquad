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
    test("Place column occludes the sprite's own screen position, sampled at one frozen pixel", async ({ page }) => {
        await gotoVariant(page, "webgl1");
        const canvas = page.locator("#glcanvas");
        const viewportPixels = [VIEWPORT_CSS.width, VIEWPORT_CSS.height];

        // The sprite shader (shader::SPRITE_FRAGMENT) outputs the
        // `tint` uniform directly with no lighting term, so its
        // rendered color is this exact value (alpha-blended over
        // whatever is behind it, but here nothing is, since this
        // sample is taken before any column write).
        const spriteTint = [1.0 * 255, 0.2 * 255, 0.3 * 255];
        function looksLikeSpriteTint(rgb, tol = 20) {
            return (
                Math.abs(rgb[0] - spriteTint[0]) <= tol &&
                Math.abs(rgb[1] - spriteTint[1]) <= tol &&
                Math.abs(rgb[2] - spriteTint[2]) <= tol
            );
        }
        // PALETTE[2] (dirt, the contract material `place_column_under_sprite`
        // writes) scaled by the shader's actual flat-shade lighting
        // range (`shade = 0.45 + 0.55 * max(dot(normal, light_dir), 0)`,
        // see `shader::TERRAIN_FRAGMENT`): this covers every face this
        // scene can expose, min shade 0.45 (a face facing away from
        // the light) through max shade ~0.94 (`HexFace::Top`, the
        // brightest possible normal here), not one assumed value.
        const dirtBase = [0.45, 0.33, 0.20];
        const minShade = 0.45;
        const maxShade = 0.45 + 0.55; // theoretical dot == 1 upper bound.
        function looksLikeDirt(rgb) {
            return (
                dirtBase.every(
                    (base, i) =>
                        rgb[i] >= base * minShade * 255 - 5 && rgb[i] <= base * maxShade * 255 + 5
                ) &&
                rgb[0] > rgb[1] &&
                rgb[1] > rgb[2] // dirt is the only palette entry with R > G > B at every shade.
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
        function bitsToFloat(bits) {
            return new Float32Array(new Uint32Array([bits]).buffer)[0];
        }
        // Reads the sprite's world position AND the exact elapsed-time
        // value (`hex_probe_sprite_t_bits`) `draw` used to compute it,
        // in one round trip, so the four values are self-consistent
        // (no risk of `x`, `y`, `z`, `t` each landing on a different
        // animation frame from separate round trips).
        async function readSpriteWorldPosAndT() {
            const { xBits, yBits, zBits, tBits } = await page.evaluate(() => ({
                xBits: window.wasm_exports.hex_probe_sprite_x_bits(),
                yBits: window.wasm_exports.hex_probe_sprite_y_bits(),
                zBits: window.wasm_exports.hex_probe_sprite_z_bits(),
                tBits: window.wasm_exports.hex_probe_sprite_t_bits()
            }));
            return { x: bitsToFloat(xBits), y: bitsToFloat(yBits), z: bitsToFloat(zBits), tBits };
        }

        // The sprite orbits continuously (about 1 radian/second, see
        // `draw`'s radius-3 circle at height ~2), so for a real,
        // correctly depth-tested scene it is only visible from this
        // fixed camera during part of its ~6.283s period -- the rest
        // of the time nearer terrain genuinely occludes it, and that
        // is correct behavior, not a fault. Search across one full
        // period (bounded, not open-ended) for an instant where the
        // sprite is actually visible, THEN freeze time at that EXACT
        // instant (see `hex_request_freeze_time`, example-only test
        // support, no UI control). Freezing takes the elapsed-time
        // value (`tBits`) sampled alongside the candidate position
        // rather than "whatever time it is when freeze is requested",
        // so the slow visibility check in this loop (a real
        // `canvas.screenshot()`) cannot let the sprite drift away from
        // the instant this search actually found: the frozen position
        // is a deterministic function of `tBits`, not of how much real
        // time has passed since the candidate was read.
        const ORBIT_PERIOD_MS = Math.ceil((2 * Math.PI) * 1000);
        const SEARCH_STEP_MS = 300;
        let before = null;
        let beforePixel = null;
        let beforeColor = null;
        for (let elapsed = 0; elapsed <= ORBIT_PERIOD_MS; elapsed += SEARCH_STEP_MS) {
            const candidate = await readSpriteWorldPosAndT();
            const candidatePixel = projectToPixel(CAMERA, [candidate.x, candidate.y, candidate.z], viewportPixels);
            if (candidatePixel) {
                const candidateColor = await colorAtPixel(candidatePixel);
                if (candidateColor && looksLikeSpriteTint(candidateColor)) {
                    before = candidate;
                    beforePixel = candidatePixel;
                    beforeColor = candidateColor;
                    break;
                }
            }
            await page.waitForTimeout(SEARCH_STEP_MS);
        }
        expect(
            before,
            "must find at least one orbit phase, within one full ~6.3s period, where the sprite is actually visible (unoccluded by pre-existing terrain) before any column write"
        ).not.toBeNull();

        await page.evaluate((tBits) => window.wasm_exports.hex_request_freeze_time(tBits), before.tBits);
        // One settle frame so `draw` renders with the frozen position
        // at least once, then re-confirm the frozen position and
        // color match what the search found. The sprite position is a
        // deterministic function of the frozen `tBits`, so this is an
        // exact-equality check, not a tolerance-based one.
        await page.waitForTimeout(50);
        const frozen = await readSpriteWorldPosAndT();
        expect(frozen, "the sprite must stay at the visible instant the search found once frozen").toEqual(before);
        beforeColor = await colorAtPixel(beforePixel);
        expect(beforeColor, "the frozen pixel must be in-viewport before the click").not.toBeNull();
        expect(
            looksLikeSpriteTint(beforeColor),
            `expected sprite tint at the frozen pixel before any column write, got rgb=${beforeColor}`
        ).toBe(true);

        const trianglesBefore = await page.evaluate(() => window.wasm_exports.hex_probe_triangles());
        await page.locator("#hex-place-column").click();
        // Short settle for one mesh rebuild + draw. The sprite itself
        // cannot drift now (time is frozen), so there is no upper
        // bound pressure on this wait; it only needs to outlast one
        // animation frame.
        await page.waitForTimeout(150);

        // Confirm the sprite's world position truly did not move
        // while frozen, so "the SAME frozen pixel" is not just an
        // assumption.
        const after = await readSpriteWorldPosAndT();
        expect(after, "the sprite must not move while time is frozen").toEqual(before);

        const afterColor = await colorAtPixel(beforePixel);
        const trianglesAfter = await page.evaluate(() => window.wasm_exports.hex_probe_triangles());

        // The column write is a hard overwrite to dirt at exactly the
        // frozen sprite's cell (contract: material identity, not face
        // count, is the only guaranteed-changed signal -- see the
        // code comment on `place_column_under_sprite`), so the SAME
        // pixel must now show dirt, not the sprite's tint.
        expect(
            looksLikeDirt(afterColor),
            `expected the SAME frozen pixel to show terrain/dirt (not the sprite tint) after Place column, got rgb=${afterColor}`
        ).toBe(true);
        expect(
            looksLikeSpriteTint(afterColor),
            "the frozen pixel must no longer show the sprite's tint once the column occludes it"
        ).toBe(false);
        expect(trianglesAfter, "Place column must never remove geometry").toBeGreaterThanOrEqual(trianglesBefore);
    });
});

test.describe("offline hex-voxel scene: real world-mutation revision and release-disables-controls", () => {
    test("hex_world_revision only advances on an actual mutation, never on idle frames", async ({ page }) => {
        await gotoVariant(page, "webgl1");

        const revisionAtLoad = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        expect(revisionAtLoad, "revision must start at 0, not a frame-tick count").toBe(0);

        // Idle frames (no click) must never advance the revision: it
        // is a bounded mutation count, not a `requestAnimationFrame`
        // tick. Several real frames render during this wait.
        await page.waitForTimeout(400);
        const revisionAfterIdle = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        expect(revisionAfterIdle, "idle frames must not advance the world revision").toBe(0);

        // The displayed text must mirror the real export, not an
        // independent frame counter.
        await expect(page.locator("#hex-revision")).toHaveText("Revision: 0");

        await page.locator("#hex-place-column").click();
        await page.waitForTimeout(150);
        const revisionAfterFirstClick = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        expect(revisionAfterFirstClick, "one real mutation must advance the revision by exactly 1").toBe(1);
        await expect(page.locator("#hex-revision")).toHaveText("Revision: 1");

        // A second click targets the same, now-already-dirt cell: it
        // is still a write attempt against a resident chunk (contract:
        // material identity, not a before/after diff, is what counts
        // as "mutated"), so the bounded counter advances again.
        await page.locator("#hex-place-column").click();
        await page.waitForTimeout(150);
        const revisionAfterSecondClick = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        expect(revisionAfterSecondClick).toBe(2);

        // Further idle frames after the mutations still must not
        // advance the counter on their own.
        await page.waitForTimeout(400);
        const revisionAfterMoreIdle = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        expect(revisionAfterMoreIdle, "idle frames after a mutation must not advance the world revision").toBe(2);
    });

    test("Release stops status updates and disables both controls", async ({ page }) => {
        await gotoVariant(page, "webgl1");

        const placeButton = page.locator("#hex-place-column");
        const releaseButton = page.locator("#hex-release");
        await expect(placeButton).toBeEnabled();
        await expect(releaseButton).toBeEnabled();
        expect(await page.evaluate(() => window.wasm_exports.resources_live())).toBeGreaterThan(0);

        await releaseButton.click();
        // Release happens on the next draw call (contract: "release
        // request -> next draw deletes GPU resources"), so wait for
        // the real `resources_live()` transition instead of assuming
        // it is synchronous with the click.
        await expect
            .poll(() => page.evaluate(() => window.wasm_exports.resources_live()), { timeout: 2000 })
            .toBe(0);

        await expect(placeButton, "Place column must be disabled once released").toBeDisabled();
        await expect(releaseButton, "Release must be disabled once released").toBeDisabled();

        const revisionAtRelease = await page.evaluate(() => window.wasm_exports.hex_world_revision());
        const statusTextAtRelease = await page.locator("#hex-revision").textContent();

        // The status-polling loop must have actually stopped: wait
        // longer than a few animation frames and confirm nothing
        // changed, rather than only checking the instant of release.
        await page.waitForTimeout(400);
        expect(
            await page.evaluate(() => window.wasm_exports.hex_world_revision()),
            "a released scene must not keep mutating its own revision"
        ).toBe(revisionAtRelease);
        await expect(
            page.locator("#hex-revision"),
            "the displayed revision text must be frozen once released"
        ).toHaveText(statusTextAtRelease);

        // A pointer click after release must not resurrect picking
        // against a scene with no GPU resources.
        await page.locator("#glcanvas").click({ position: { x: 320, y: 180 } });
        await page.waitForTimeout(100);
        expect(
            await page.evaluate(() => window.wasm_exports.resources_live()),
            "released resources must stay released"
        ).toBe(0);
    });
});

test.describe("offline hex-voxel scene: idempotent release across mount cycles", () => {
    // `js/gl.js` documents (comment above its `load()` function): "A
    // canvas has one WASM application lifecycle." The module-scope
    // `const canvas = document.querySelector("#glcanvas")` at the top
    // of that file is bound once per page evaluation and cannot be
    // re-pointed at a fresh element without re-running the script.
    // A full `page.reload()` is therefore the only existing
    // embedding mechanism that gives a genuinely new WASM application
    // lifecycle (new linear memory, new WebGL context); this test
    // does not invent an in-page "remount" API gl.js does not
    // support. What it strengthens over a bare reload-and-count
    // check is: (1) exact per-object GL identity bijection within
    // each cycle, not just aggregate counts (a leak plus an extra
    // create could otherwise cancel out in a count comparison), and
    // (2) a real `wasm_exports.memory.buffer.byteLength` sample per
    // cycle, to catch an accidental growth in this example's
    // steady-state allocation across remounts.
    test("three mount/release cycles each reach resources_live()==0, exact GL identity bijection, and no WASM memory growth", async ({ page }) => {
        const liveCounts = [];
        const identityChecks = [];
        const memoryBytesPerCycle = [];
        for (let cycle = 0; cycle < 3; cycle++) {
            await page.addInitScript(() => {
                window.__glCreated = [];
                window.__glDeleted = [];
                for (const klass of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
                    if (!klass?.prototype) continue;
                    for (const name of ["createBuffer", "createProgram"]) {
                        const original = klass.prototype[name];
                        if (!original || klass.prototype[name].__hexWrapped) continue;
                        klass.prototype[name] = function (...args) {
                            const object = original.apply(this, args);
                            window.__glCreated.push(object);
                            return object;
                        };
                        klass.prototype[name].__hexWrapped = true;
                    }
                    for (const name of ["deleteBuffer", "deleteProgram"]) {
                        const original = klass.prototype[name];
                        if (!original || klass.prototype[name].__hexWrapped) continue;
                        klass.prototype[name] = function (object, ...rest) {
                            window.__glDeleted.push(object);
                            return original.call(this, object, ...rest);
                        };
                        klass.prototype[name].__hexWrapped = true;
                    }
                }
            });
            await gotoVariant(page, "webgl1");
            const before = await page.evaluate(() => window.wasm_exports.resources_live());
            expect(before, `cycle ${cycle}: resources_live() must be nonzero before release`).toBeGreaterThan(0);

            const memoryBytes = await page.evaluate(() => window.wasm_exports.memory.buffer.byteLength);
            memoryBytesPerCycle.push(memoryBytes);

            await page.locator("#hex-release").click();
            await page.waitForTimeout(200);
            const after = await page.evaluate(() => window.wasm_exports.resources_live());
            expect(after, `cycle ${cycle}: resources_live() must reach 0 after release`).toBe(0);
            liveCounts.push({ cycle, before, after });

            // Real identity bijection: every object instance this
            // cycle created must appear in the deleted list exactly
            // once (JSHandle equality via elementHandle-less
            // in-page Set comparison, done entirely inside the page
            // to keep object identity meaningful).
            const identity = await page.evaluate(() => {
                const created = window.__glCreated;
                const deleted = window.__glDeleted;
                const deletedRemaining = [...deleted];
                let unmatchedCreated = 0;
                for (const object of created) {
                    const index = deletedRemaining.indexOf(object);
                    if (index === -1) unmatchedCreated++;
                    else deletedRemaining.splice(index, 1);
                }
                return {
                    createdCount: created.length,
                    deletedCount: deleted.length,
                    unmatchedCreated,
                    // Any delete call left over after matching every
                    // created object is a delete of something this
                    // cycle never created (foreign/stale handle).
                    unmatchedDeleted: deletedRemaining.length
                };
            });
            identityChecks.push({ cycle, ...identity });
            expect(identity.unmatchedCreated, `cycle ${cycle}: every created GL object must be deleted exactly once`).toBe(0);
            expect(identity.unmatchedDeleted, `cycle ${cycle}: no delete may target an object this cycle did not create`).toBe(0);

            await page.reload();
        }
        expect(
            new Set(memoryBytesPerCycle).size,
            `WASM memory size must not grow across mount cycles, got ${JSON.stringify(memoryBytesPerCycle)}`
        ).toBe(1);
        fs.writeFileSync(
            path.join(rawArtifactDir, "release-cycles.json"),
            JSON.stringify({ liveCounts, identityChecks, memoryBytesPerCycle }, null, 2)
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
