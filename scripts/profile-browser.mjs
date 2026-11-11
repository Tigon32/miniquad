#!/usr/bin/env node
// Measurement harness for issue #14: paired baseline/candidate browser
// profiling of examples/browser_perf.rs. Never fabricates a sample; a
// missing or unavailable measurement is recorded as `null` with a reason.
//
// Pure helpers below (percentile, aggregate, pairDelta, summarizePairs,
// validateSamples, compressionReport) have no browser dependency and are
// covered directly by tests/profile-browser.test.mjs.
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localRequire = createRequire(import.meta.url);

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

/** Drop non-finite/missing samples; report why, never silently invent data. */
export function validateSamples(samples) {
  const valid = [];
  const dropped = [];
  for (const value of samples ?? []) {
    if (typeof value === "number" && Number.isFinite(value)) valid.push(value);
    else dropped.push(value === undefined ? "missing" : String(value));
  }
  return { valid, droppedCount: dropped.length, droppedReasons: dropped };
}

export function aggregate(samples) {
  const { valid, droppedCount } = validateSamples(samples);
  const sorted = [...valid].sort((a, b) => a - b);
  return {
    count: valid.length,
    droppedCount,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/** Signed and percent change of candidate relative to baseline. */
export function pairDelta(baselineValue, candidateValue) {
  if (typeof baselineValue !== "number" || typeof candidateValue !== "number" ||
      !Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) {
    return { bytes: null, percent: null, reason: "missing baseline or candidate sample" };
  }
  const bytes = candidateValue - baselineValue;
  const percent = baselineValue === 0 ? null : Number((bytes * 100 / baselineValue).toFixed(3));
  return { bytes, percent, reason: null };
}

/**
 * Median of per-pair deltas and a noise spread (max - min of the deltas).
 * If the absolute median delta does not exceed the spread, the result is
 * INCONCLUSIVE: noise is at least as large as the observed difference.
 */
export function summarizePairs(deltas) {
  const finite = deltas.filter((d) => typeof d === "number" && Number.isFinite(d));
  if (finite.length === 0) {
    return { sampleCount: 0, medianDelta: null, spread: null, verdict: "INCONCLUSIVE", reason: "no valid pair deltas" };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianDelta = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const spread = sorted[sorted.length - 1] - sorted[0];
  const verdict = Math.abs(medianDelta) >= spread && spread > 0 ? "MEASURED" : (spread === 0 ? "MEASURED" : "INCONCLUSIVE");
  return { sampleCount: finite.length, medianDelta: Number(medianDelta.toFixed(4)), spread: Number(spread.toFixed(4)), verdict };
}

export function compressionReport(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
}

/** Find a sibling worktree's installed, pinned Playwright without adding a dependency here. */
export function resolvePlaywrightEntry(env = process.env) {
  if (env.MINIQUAD_PLAYWRIGHT_ENTRY && existsSync(env.MINIQUAD_PLAYWRIGHT_ENTRY)) {
    return env.MINIQUAD_PLAYWRIGHT_ENTRY;
  }
  const local = resolve(repoRoot, "node_modules/playwright/index.js");
  if (existsSync(local)) return local;
  const parent = dirname(repoRoot);
  const siblings = readdirSync(parent).sort((a, b) => (a === "miniquad" ? -1 : b === "miniquad" ? 1 : 0));
  for (const name of siblings) {
    const candidate = resolve(parent, name, "node_modules/playwright/index.js");
    if (candidate !== local && existsSync(candidate)) return candidate;
  }
  throw new Error("Playwright not found locally or in a sibling worktree. Set MINIQUAD_PLAYWRIGHT_ENTRY.");
}

const FIXTURE = "browser_perf";
const BASELINE_WASM = resolve(repoRoot, `target/wasm32-unknown-unknown/release/examples/${FIXTURE}.wasm`);
const CANDIDATE_WASM = resolve(repoRoot, `target/profiling-experiment/wasm32-unknown-unknown/release/examples/${FIXTURE}.wasm`);
const RUST_FLAGS_CANDIDATE = "-C opt-level=z";
const WARM_FRAMES = 90;
const CPU_SAMPLES = 60;
const FREEZE_FRAME = 120;
const VIEWPORT = { width: 640, height: 400 };
const LAUNCH_ARGS = ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];

function startServer() {
  const routes = new Map([
    ["/js/gl.js", resolve(repoRoot, "js/gl.js")],
    ["/baseline/browser_perf.wasm", BASELINE_WASM],
    ["/candidate/browser_perf.wasm", CANDIDATE_WASM],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      const variant = url.searchParams.get("variant") === "candidate" ? "candidate" : "baseline";
      const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
        `<canvas id="glcanvas" width="${VIEWPORT.width}" height="${VIEWPORT.height}" tabindex="0"></canvas>` +
        `<script src="/js/gl.js"></script><script>load("/${variant}/browser_perf.wasm");</script></body></html>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    const file = routes.get(url.pathname);
    if (!file || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const type = file.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8";
    response.writeHead(200, { "content-type": type });
    response.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/**
 * Browser-side init script: instrument WebGL and the WASM frame call, never
 * mutate WASM. Passed to `page.addInitScript(fn, arg)` so `freezeFrame` is
 * delivered as a real argument, not captured by a lost JS closure.
 */
function pageInstrumentation(freezeFrame) {
    window.__perf = {
      frameIntervals: [], cpuFrameMs: [], firstDrawMs: null, firstWasmFrameCallbackMs: null,
      bufferUploadCalls: 0, bufferUploadBytes: 0, textureUploadCalls: 0, textureUploadBytes: 0,
      bindTextureCalls: 0, drawCalls: 0, frozenAtFrame: null,
    };
    function byteLengthOf(data) {
      if (!data) return 0;
      if (ArrayBuffer.isView(data)) return data.byteLength;
      if (data instanceof ArrayBuffer) return data.byteLength;
      return 0;
    }
    function wrap(proto, method, onCall) {
      if (typeof proto?.[method] !== "function") return;
      const original = proto[method];
      proto[method] = function (...args) {
        onCall(args);
        return original.apply(this, args);
      };
    }
    for (const klass of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!klass?.prototype) continue;
      wrap(klass.prototype, "bufferData", (args) => {
        window.__perf.bufferUploadCalls += 1;
        window.__perf.bufferUploadBytes += typeof args[1] === "number" ? args[1] : byteLengthOf(args[1]);
      });
      wrap(klass.prototype, "bufferSubData", (args) => {
        window.__perf.bufferUploadCalls += 1;
        window.__perf.bufferUploadBytes += byteLengthOf(args[2]);
      });
      wrap(klass.prototype, "texImage2D", (args) => {
        window.__perf.textureUploadCalls += 1;
        window.__perf.textureUploadBytes += byteLengthOf(args[args.length - 1]);
      });
      wrap(klass.prototype, "texSubImage2D", (args) => {
        window.__perf.textureUploadCalls += 1;
        window.__perf.textureUploadBytes += byteLengthOf(args[args.length - 1]);
      });
      wrap(klass.prototype, "bindTexture", () => { window.__perf.bindTextureCalls += 1; });
      const recordDraw = () => {
        window.__perf.drawCalls += 1;
        if (window.__perf.firstDrawMs === null) window.__perf.firstDrawMs = performance.now();
      };
      // miniquad's GL backend always issues the *Instanced variants, even for one instance.
      for (const method of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        wrap(klass.prototype, method, recordDraw);
      }
      const originalGetExtension = klass.prototype.getExtension;
      if (typeof originalGetExtension === "function") {
        const instrumentedExtensions = new WeakSet();
        klass.prototype.getExtension = function (...args) {
          const extension = originalGetExtension.apply(this, args);
          if (extension && String(args[0]).toLowerCase() === "angle_instanced_arrays" && !instrumentedExtensions.has(extension)) {
            for (const method of ["drawArraysInstancedANGLE", "drawElementsInstancedANGLE"]) wrap(extension, method, recordDraw);
            instrumentedExtensions.add(extension);
          }
          return extension;
        };
      }
    }
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (callback) {
      if (window.__perf.frameIntervals.length >= freezeFrame) {
        window.__perf.frozenAtFrame = window.__perf.frameIntervals.length;
        return 0; // Deterministic freeze: stop scheduling further redraws.
      }
      return raf.call(this, (timestamp) => {
        if (typeof wasm_exports === "object" && typeof wasm_exports.frame === "function") {
          if (window.__perf.firstWasmFrameCallbackMs === null) window.__perf.firstWasmFrameCallbackMs = performance.now();
          window.__perf.frameIntervals.push(timestamp);
        }
        return callback(timestamp);
      });
    };
}

async function runOnce(playwright, serverUrl, variant, freezeFrame) {
  const browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await page.addInitScript(pageInstrumentation, freezeFrame);
  await page.goto(`${serverUrl}/?variant=${variant}`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" && typeof wasm_exports.frame === "function", null, { polling: 50 });
  await page.evaluate(() => {
    const original = wasm_exports;
    wasm_exports = { ...original, frame(...args) {
      const before = performance.now();
      try { return original.frame(...args); } finally { window.__perf.cpuFrameMs.push(performance.now() - before); }
    } };
  });
  await page.waitForFunction(
    (needed) => window.__perf.frozenAtFrame !== null && window.__perf.cpuFrameMs.length >= needed,
    CPU_SAMPLES, { timeout: 30000, polling: 50 },
  );
  await page.waitForTimeout(150); // let the freeze settle before reading pixels
  const metrics = await page.evaluate(() => {
    const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
    const width = canvas.width, height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    try { gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); } catch { /* left empty */ }
    return {
      perf: window.__perf,
      jsHeapUsedBytes: heap,
      jsHeapReason: heap === null ? "performance.memory unavailable in this engine/mode" : null,
      wasmMemoryBytes: typeof wasm_memory === "object" ? wasm_memory.buffer.byteLength : null,
      pixels: Array.from(pixels),
      canvasSize: { width, height },
    };
  });
  const cpuProfile = (await cdp.send("Profiler.stop")).profile;
  await browser.close();
  const intervals = metrics.perf.frameIntervals.slice(1).map((t, i) => t - metrics.perf.frameIntervals[i]);
  return {
    variant,
    firstWebGLDrawSubmissionMs: metrics.perf.firstDrawMs,
    firstWasmFrameCallbackMs: metrics.perf.firstWasmFrameCallbackMs,
    frameIntervalMs: aggregate(intervals),
    jsToWasmFrameCallMs: aggregate(metrics.perf.cpuFrameMs),
    webgl: {
      bufferUploadCalls: metrics.perf.bufferUploadCalls,
      bufferUploadBytes: metrics.perf.bufferUploadBytes,
      textureUploadCalls: metrics.perf.textureUploadCalls,
      textureUploadBytes: metrics.perf.textureUploadBytes,
      bindTextureCalls: metrics.perf.bindTextureCalls,
      drawCalls: metrics.perf.drawCalls,
    },
    wasmMemoryBytes: metrics.wasmMemoryBytes,
    jsHeapUsedBytes: metrics.jsHeapUsedBytes,
    jsHeapReason: metrics.jsHeapReason,
    allocationProfiling: { available: false, reason: "No CDP heap-allocation sampling is wired up; not claimed as done (see issue #14)." },
    cpuProfileTopNodes: topCpuProfileNodes(cpuProfile, 5),
    pixelsBase64: Buffer.from(metrics.pixels).toString("base64"),
    canvasSize: metrics.canvasSize,
  };
}

function topCpuProfileNodes(profile, limit) {
  if (!profile?.nodes) return [];
  const hits = new Map();
  for (const sampleId of profile.samples ?? []) hits.set(sampleId, (hits.get(sampleId) ?? 0) + 1);
  return [...profile.nodes]
    .map((node) => ({ id: node.id, name: node.callFrame?.functionName || "(anonymous)", url: node.callFrame?.url || "", hitCount: hits.get(node.id) ?? node.hitCount ?? 0 }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, limit);
}

export function pixelParity(baseline, candidate, tolerancePerChannel) {
  if (baseline.length !== candidate.length) return { equalSize: false, maxChannelDiff: null, mismatchedPixelRatio: null };
  let maxDiff = 0, mismatched = 0;
  const pixelCount = baseline.length / 4;
  for (let i = 0; i < baseline.length; i += 4) {
    let pixelDiff = 0;
    for (let c = 0; c < 4; c++) pixelDiff = Math.max(pixelDiff, Math.abs(baseline[i + c] - candidate[i + c]));
    if (pixelDiff > maxDiff) maxDiff = pixelDiff;
    if (pixelDiff > tolerancePerChannel) mismatched += 1;
  }
  return { equalSize: true, maxChannelDiff: maxDiff, mismatchedPixelRatio: Number((mismatched / pixelCount).toFixed(6)) };
}

async function main() {
  const playwrightEntry = resolvePlaywrightEntry();
  const playwright = localRequire(playwrightEntry);
  const server = await startServer();
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const pairCount = Number(process.env.MINIQUAD_PROFILE_PAIRS || 5);
  const pairs = [];
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    const order = pairIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const runs = {};
    for (const variant of order) runs[variant] = await runOnce(playwright, serverUrl, variant, FREEZE_FRAME);
    pairs.push({ pairIndex, order, baseline: runs.baseline, candidate: runs.candidate });
  }
  server.close();

  const baselineBytes = readFileSync(BASELINE_WASM);
  const candidateBytes = readFileSync(CANDIDATE_WASM);
  const sizes = { baseline: compressionReport(baselineBytes), candidate: compressionReport(candidateBytes) };

  const metricPaths = [
    ["frameIntervalMs", "p50"], ["frameIntervalMs", "p95"], ["frameIntervalMs", "p99"],
    ["jsToWasmFrameCallMs", "p50"], ["jsToWasmFrameCallMs", "p95"], ["jsToWasmFrameCallMs", "p99"],
  ];
  const comparisons = {};
  for (const [group, stat] of metricPaths) {
    const deltas = pairs.map((p) => pairDelta(p.baseline[group][stat], p.candidate[group][stat]).bytes);
    comparisons[`${group}.${stat}`] = summarizePairs(deltas);
  }

  const parity = pairs.map((p) => ({
    pairIndex: p.pairIndex,
    ...pixelParity(Buffer.from(p.baseline.pixelsBase64, "base64"), Buffer.from(p.candidate.pixelsBase64, "base64"), 2),
  }));

  const report = {
    schema: 1,
    sourceRevision: process.env.GITHUB_SHA || "see git rev-parse HEAD",
    fixture: "examples/browser_perf.rs",
    rustFlagsCandidate: RUST_FLAGS_CANDIDATE,
    rustcVersion: process.env.MINIQUAD_RUSTC_VERSION || "see `rustc --version`",
    browser: "chromium (pinned Playwright, headless, software GPU/SwiftShader)",
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    launchArgs: LAUNCH_ARGS,
    pairCount,
    warmFrameTarget: WARM_FRAMES,
    cpuSampleTarget: CPU_SAMPLES,
    freezeFrame: FREEZE_FRAME,
    sizes,
    pairs: pairs.map((p) => ({
      pairIndex: p.pairIndex, order: p.order,
      baseline: { ...p.baseline, pixelsBase64: undefined },
      candidate: { ...p.candidate, pixelsBase64: undefined },
    })),
    comparisons,
    pixelParity: parity,
    limitations: "Warm headless software-GPU samples, not a GPU-timer or real-device measurement. GPU completion time is not collected and is never reported as zero. Allocation/heap profiling is not available in this harness.",
  };

  const outDir = process.env.MINIQUAD_PROFILE_OUT_DIR || resolve(repoRoot, "test-results");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `browser-profile-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log("Wrote raw browser profile receipt to", outFile);
  console.log(JSON.stringify({ sizes, comparisons, pixelParity: parity }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
