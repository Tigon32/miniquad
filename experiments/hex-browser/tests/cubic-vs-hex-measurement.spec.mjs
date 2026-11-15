// Issue #131's "measurement" acceptance item: run the cubic and hex
// examples on the same browser, host, canvas size, device pixel ratio,
// seed, and exact cell inputs. The cubic fixture opts into
// `measurement-equal-cells`; the default cubic example is unchanged.
// RUN_COUNT is 40 page loads per engine: 20 alternating pairs and 20
// samples per scene.
// Record real numbers, with any unavailable value left `null` with a
// stated reason -- never fabricated.
//
// This spec supplies the equal-cell comparison referenced by
// `hex-offline.spec.mjs`'s "honest measurements" record. The cubic
// fixture uses an opt-in feature and runs on the same private port 4290
// harness as the hex fixtures. The default cubic example's dimensions
// and coordinates do not change.
//
// Honesty notes:
//   - Frame-interval samples are measured for real in both engines'
//     real browsers (not just Chromium), under the identical 640x360
//     canvas and DPR 1 this harness already uses for the hex scene.
//   - Exact vertex/index counts and a native (non-browser) mesh-build
//     time come from `cargo run --release --example measure_mesh`
//     (companions/voxel/examples/measure_mesh.rs), which reproduces
//     each scene's exact world/mesh construction using the same
//     public library calls, seed, dims, and chunk coordinates as each
//     example's own `Stage::new` -- not a separate, unverified
//     estimate. That binary's own internal assertions already confirm
//     both scenes are perfectly deterministic (identical vertex/index
//     counts) across its 20 internal alternating runs.
//   - Native mesh-build time is NOT a substitute for an in-browser
//     build-time measurement: neither example exports a build-time
//     probe (adding one to the cubic example is against the issue's
//     "stays unchanged" rule), so no in-browser build-time claim is
//     made for either scene; this is stated explicitly in the record
//     below, not silently conflated with the frame-interval numbers.
//   - Both measurement scenes use the same `WORLD_SEED` (20261111),
//     `ChunkDims` (8x4x8), chunk coordinates `(-1,0,0)` and `(0,0,0)`,
//     and generated voxel IDs. The cubic and hex mesh topologies differ,
//     so vertex/index counts need not match.
//   - No performance-promotion claim ("cubic/hex is faster/better")
//     is made anywhere in this file: only the measured numbers and
//     their stated conditions are recorded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const rawArtifactDir =
    process.env.HEX_BROWSER_ARTIFACT_DIR || path.join(repoRoot, "test-results/hex-browser/measurements");
fs.mkdirSync(rawArtifactDir, { recursive: true });

const VIEWPORT_CSS = { width: 640, height: 360 };
const RUN_COUNT = 40;

async function gotoScene(page, scene) {
    const url = scene === "hex" ? "/?variant=webgl1" : "/cubic-measurement";
    const readyCheck =
        scene === "hex"
            ? () => typeof window.wasm_exports === "object" && typeof window.wasm_exports.hex_probe_pick === "function"
            : () => typeof window.gl === "object";
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(readyCheck);
    // Same settle convention as hex-offline.spec.mjs's `gotoVariant`.
    await page.waitForTimeout(250);
}

async function sampleFrameIntervalP95P99(page) {
    const intervals = await page.evaluate(
        () =>
            new Promise(resolve => {
                const samples = [];
                let last = performance.now();
                function tick() {
                    const now = performance.now();
                    samples.push(now - last);
                    last = now;
                    if (samples.length < 60) requestAnimationFrame(tick);
                    else resolve(samples.slice(1)); // drop the first (startup) sample.
                }
                requestAnimationFrame(tick);
            })
    );
    intervals.sort((a, b) => a - b);
    const percentile = p => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))];
    return { p95: percentile(0.95), p99: percentile(0.99), sampleCount: intervals.length };
}

async function readWebGLInfo(page) {
    return page.evaluate(() => {
        const context = window.gl;
        if (!context || typeof context.getParameter !== "function") return null;
        const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
        return {
            version: context.getParameter(context.VERSION),
            vendor: debugInfo
                ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
                : context.getParameter(context.VENDOR),
            renderer: debugInfo
                ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                : context.getParameter(context.RENDERER),
            unmaskedRendererAvailable: Boolean(debugInfo)
        };
    });
}

function rangeStats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / sorted.length,
        runCount: sorted.length
    };
}

test.describe("cubic vs hex: alternating measurement", () => {
    test("records frame-interval p95/p99 for both examples and native mesh/build stats", async ({
        page,
        browser
    }, testInfo) => {
        // 40 alternating page loads plus a native cargo run exceed the
        // suite's default 45s per-test timeout.
        test.setTimeout(180000);
        // Exact (not estimated) vertex/index counts and a native
        // mesh-build-time distribution, both scenes, same host,
        // same process of measurement.
        const measureMeshOutput = execFileSync(
            "cargo",
            ["run", "--release", "--example", "measure_mesh"],
            { cwd: path.join(repoRoot, "companions/voxel"), encoding: "utf8" }
        );
        const nativeMesh = JSON.parse(measureMeshOutput);
        expect(nativeMesh.cubic.vertices).toBeGreaterThan(0);
        expect(nativeMesh.hex.vertices).toBeGreaterThan(0);
        expect(nativeMesh.cubic.gridCellCapacity).toBe(nativeMesh.hex.gridCellCapacity);
        expect(nativeMesh.cubic.solidCells).toBe(nativeMesh.hex.solidCells);

        // Real, paired/alternating browser runs: hex, cubic, hex,
        // cubic, ... so neither scene systematically runs while the
        // host is warmer/cooler than the other.
        const hexP95 = [];
        const hexP99 = [];
        const cubicP95 = [];
        const cubicP99 = [];
        const webglInfo = {};
        for (let i = 0; i < RUN_COUNT; i++) {
            const scene = i % 2 === 0 ? "hex" : "cubic";
            await gotoScene(page, scene);
            if (!webglInfo[scene]) {
                webglInfo[scene] = await readWebGLInfo(page);
                expect(webglInfo[scene]).not.toBeNull();
                expect(webglInfo[scene].version).toContain("WebGL 1.0");
            }
            const { p95, p99 } = await sampleFrameIntervalP95P99(page);
            if (scene === "hex") {
                hexP95.push(p95);
                hexP99.push(p99);
            } else {
                cubicP95.push(p95);
                cubicP99.push(p99);
            }
        }

        const hexWasmBytes = Buffer.from(await (await page.request.get("/offline_hex_webgl1.wasm")).body());
        const cubicWasmBytes = Buffer.from(await (await page.request.get("/offline_cubic_webgl1.wasm")).body());
        const jsBytes = fs.readFileSync(path.join(repoRoot, "js/gl.js"));
        const jsGzipBytes = zlib.gzipSync(jsBytes).length;
        const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8"
        }).trim();

        const record = {
            conditions: {
                sourceSha,
                browser: testInfo.project.name,
                browserVersion: browser.version(),
                os: process.platform,
                osRelease: os.release(),
                architecture: os.arch(),
                canvas: VIEWPORT_CSS,
                dpr: 1,
                seed: 20261111,
                residentChunkCount: 2,
                pageLoads: RUN_COUNT,
                pairedRuns: RUN_COUNT / 2,
                runsPerScene: RUN_COUNT / 2,
                chunkDims: [8, 4, 8],
                chunkCoords: [[-1, 0, 0], [0, 0, 0]],
                cubicBuildFeature: "measurement-equal-cells"
            },
            webgl: {
                cubic: webglInfo.cubic,
                hex: webglInfo.hex
            },
            cubic: {
                gridCellCapacity: nativeMesh.cubic.gridCellCapacity,
                solidCells: nativeMesh.cubic.solidCells,
                vertices: nativeMesh.cubic.vertices,
                indices: nativeMesh.cubic.indices,
                nativeMeshBuildTimeNs: nativeMesh.cubic.buildTimeNs,
                nativeMeshBuildTimeNote:
                    "native (non-browser) host build time; not an in-browser/WASM build-time measurement -- the measurement feature exports no build-time probe",
                wasmBytes: cubicWasmBytes.length,
                wasmGzipBytes: zlib.gzipSync(cubicWasmBytes).length,
                frameIntervalMsP95: rangeStats(cubicP95),
                frameIntervalMsP99: rangeStats(cubicP99)
            },
            hex: {
                gridCellCapacity: nativeMesh.hex.gridCellCapacity,
                solidCells: nativeMesh.hex.solidCells,
                vertices: nativeMesh.hex.vertices,
                indices: nativeMesh.hex.indices,
                nativeMeshBuildTimeNs: nativeMesh.hex.buildTimeNs,
                nativeMeshBuildTimeNote:
                    "native (non-browser) host build time; not an in-browser/WASM build-time measurement -- neither example exports a build-time probe",
                wasmBytes: hexWasmBytes.length,
                wasmGzipBytes: zlib.gzipSync(hexWasmBytes).length,
                frameIntervalMsP95: rangeStats(hexP95),
                frameIntervalMsP99: rangeStats(hexP99)
            },
            jsBytes: jsBytes.length,
            jsGzipBytes: jsGzipBytes,
            jsSha256: createHash("sha256").update(jsBytes).digest("hex"),
            gpuMetricsUnavailable: {
                vramBytes: null,
                reason: "WebGL exposes no portable VRAM/driver-memory query; not measured, not estimated."
            }
        };

        fs.writeFileSync(
            path.join(rawArtifactDir, `cubic-vs-hex-${testInfo.project.name}.json`),
            JSON.stringify(record, null, 2)
        );

        expect(record.cubic.frameIntervalMsP95.mean).toBeGreaterThan(0);
        expect(record.hex.frameIntervalMsP95.mean).toBeGreaterThan(0);
        expect(record.cubic.wasmGzipBytes).toBeGreaterThan(0);
        expect(record.hex.wasmGzipBytes).toBeGreaterThan(0);
    });
});
