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

/**
 * Component-wise `current - init` for the real Rust allocation call-count
 * counters exported by `examples/browser_perf.rs`'s `alloc_profile` module
 * (only present when built with `RUSTFLAGS="--cfg miniquad_alloc_profile"`).
 * Always a total over the measured window, never divided by a frame count
 * or duration here: a caller that wants a rate must compute and label it
 * explicitly elsewhere; this function never does so itself.
 *
 * Call-count fields (`allocCalls`/`reallocCalls`/`deallocCalls`) must never
 * decrease between `init` and `current` for a correctly-ordered pair
 * (nothing resets them); a decrease means the caller passed a bad/reversed
 * pair, so this returns `{available: false, reason}` rather than silently
 * reporting a clamped-to-zero or negative call count.
 *
 * `liveBytesDelta` is a real signed subtraction: a window with more frees
 * than allocs legitimately reports a negative number, never clamped.
 *
 * `peakBytes` is NOT diffed here. It has separate semantics (an absolute
 * watermark, rebased by `alloc_profile_reset_peak()`): callers must read it
 * directly from the WASM export for each window instead of asking this
 * function to subtract two unrelated watermarks (see `runAllocationProfile`
 * and `docs/browser-profiling.md`).
 */
export function allocationPhaseDelta(init, current) {
  const fields = ["allocCalls", "reallocCalls", "deallocCalls", "liveBytes"];
  const missing = fields.filter((f) => typeof init?.[f] !== "number" || typeof current?.[f] !== "number");
  if (missing.length > 0) {
    return { available: false, reason: `missing counter field(s): ${missing.join(", ")}` };
  }
  for (const field of ["allocCalls", "reallocCalls", "deallocCalls"]) {
    if (current[field] < init[field]) {
      return {
        available: false,
        reason: `${field} decreased from ${init[field]} to ${current[field]}; ` +
          "call counts never legitimately decrease, so (init, current) is a bad or reversed pair",
      };
    }
  }
  return {
    available: true,
    allocCalls: current.allocCalls - init.allocCalls,
    reallocCalls: current.reallocCalls - init.reallocCalls,
    deallocCalls: current.deallocCalls - init.deallocCalls,
    liveBytesDelta: current.liveBytes - init.liveBytes,
  };
}

/** Decode the exported `alloc_profile_selftest_result` scalar (-1/0/1). */
export function decodeSelftestResult(value) {
  const n = Number(value);
  if (n === 1) return { ran: true, pass: true };
  if (n === 0) return { ran: true, pass: false };
  return { ran: false, pass: null };
}

/**
 * Flatten a CDP `HeapProfiler` sampling profile tree
 * (`{head: {callFrame, selfSize, children}}`) into the top-N call sites by
 * total self size, aggregating recurring function names/urls across the
 * tree instead of reporting duplicate leaves. Pure and browser-free so it
 * is covered directly by `tests/profile-browser.test.mjs`.
 */
export function topHeapSamplingNodes(samplingProfile, limit) {
  const totals = new Map();
  function visit(node) {
    if (!node) return;
    const name = node.callFrame?.functionName || "(anonymous)";
    const url = node.callFrame?.url || "";
    const key = `${name}\u0000${url}`;
    const prior = totals.get(key) ?? { name, url, selfSize: 0 };
    prior.selfSize += node.selfSize ?? 0;
    totals.set(key, prior);
    for (const child of node.children ?? []) visit(child);
  }
  visit(samplingProfile?.head);
  return [...totals.values()]
    .filter((n) => n.selfSize > 0)
    .sort((a, b) => b.selfSize - a.selfSize)
    .slice(0, limit);
}

export function compressionReport(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
}

/**
 * SHA-256 of the exact source files this receipt's claims depend on, plus
 * the actual `alloc-profile` WASM artifact file, read at harness run time.
 * This does not rebuild anything itself: it exists so a reader can cross-
 * check these hashes against the receipt document's recorded hashes and
 * catch a stale/unrebuilt `alloc-profile.wasm` being silently attributed to
 * the current source.
 */
export function sourceProvenance() {
  const files = {
    "scripts/profile-browser.mjs": resolve(repoRoot, "scripts/profile-browser.mjs"),
    "js/gl.js": resolve(repoRoot, "js/gl.js"),
    "examples/browser_perf.rs": resolve(repoRoot, "examples/browser_perf.rs"),
    "experiments/allocation-profile/src/core.rs": resolve(repoRoot, "experiments/allocation-profile/src/core.rs"),
    "experiments/allocation-profile/src/lib.rs": resolve(repoRoot, "experiments/allocation-profile/src/lib.rs"),
  };
  const sourceSha256 = {};
  for (const [label, path] of Object.entries(files)) {
    sourceSha256[label] = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  }
  const allocProfileWasmSha256 = existsSync(ALLOC_PROFILE_WASM)
    ? createHash("sha256").update(readFileSync(ALLOC_PROFILE_WASM)).digest("hex")
    : null;
  return { sourceSha256, allocProfileWasmSha256 };
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
// Built separately with `RUSTFLAGS="--cfg miniquad_alloc_profile"`; see
// `examples/browser_perf.rs`'s `alloc_profile` module doc. Absent unless
// that exact build was run first; `runAllocationProfile` records
// `available: false` rather than failing the whole harness invocation.
const ALLOC_PROFILE_WASM = resolve(
  repoRoot,
  `target/alloc-profile-experiment/wasm32-unknown-unknown/release/examples/${FIXTURE}.wasm`,
);
const RUST_FLAGS_CANDIDATE = "-C opt-level=z";
const WARM_FRAMES = 90;
const CPU_SAMPLES = 60;
const FREEZE_FRAME = 120;
// Two-equal-window steady-phase allocation measurement (see
// `runAllocationProfile`): WARMUP_FRAMES lets startup/cold-start
// allocation settle before either window starts; each of the two windows
// is STEADY_WINDOW_FRAMES long, so WARMUP_FRAMES + 2 * STEADY_WINDOW_FRAMES
// must equal FREEZE_FRAME (the same freeze point used everywhere else).
const WARMUP_FRAMES = 60;
const STEADY_WINDOW_FRAMES = 30;
if (WARMUP_FRAMES + 2 * STEADY_WINDOW_FRAMES !== FREEZE_FRAME) {
  throw new Error("WARMUP_FRAMES + 2*STEADY_WINDOW_FRAMES must equal FREEZE_FRAME");
}
/**
 * Exact frame boundaries at which `pageInstrumentation`'s own
 * `requestAnimationFrame` override must snapshot the real alloc-profile
 * counters, *synchronously, in-page*, at the instant `window.__perf
 * .frameIntervals.length` equals `frame` -- never via a later Node-side
 * `page.waitForFunction(() => ... >= n)` + separate `page.evaluate`, which
 * races: by the time the `evaluate` round-trip lands, more frames (whole
 * `requestAnimationFrame` ticks, each driven by the page's own render
 * loop) may already have run past `n`, silently narrowing or widening the
 * measured window without anything throwing. Entries that share a `frame`
 * run back-to-back in array order with zero elapsed frames between them
 * (this is how `windowAEnd` and `windowBStart` are the same instant: no
 * frame separates "window A just ended" from "window B's baseline, after
 * resetting peak, is read").
 */
export const ALLOC_WINDOW_PLAN = [
  { frame: WARMUP_FRAMES, name: "windowAStart", resetPeak: true },
  { frame: WARMUP_FRAMES + STEADY_WINDOW_FRAMES, name: "windowAEnd", resetPeak: false },
  { frame: WARMUP_FRAMES + STEADY_WINDOW_FRAMES, name: "windowBStart", resetPeak: true },
  { frame: WARMUP_FRAMES + 2 * STEADY_WINDOW_FRAMES, name: "windowBEnd", resetPeak: false },
];
// Explicit, finite timeout for every `page.waitForFunction` call in this
// file: a condition that never becomes true must fail loudly, not hang
// forever and leak a headless Chromium process.
const WAIT_TIMEOUT_MS = 30000;
const VIEWPORT = { width: 640, height: 400 };
const LAUNCH_ARGS = ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];

function startServer() {
  const routes = new Map([
    ["/js/gl.js", resolve(repoRoot, "js/gl.js")],
    ["/baseline/browser_perf.wasm", BASELINE_WASM],
    ["/candidate/browser_perf.wasm", CANDIDATE_WASM],
    ["/alloc-profile/browser_perf.wasm", ALLOC_PROFILE_WASM],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      const requested = url.searchParams.get("variant");
      const variant = requested === "candidate" || requested === "alloc-profile" ? requested : "baseline";
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
 * mutate WASM. Passed to `page.addInitScript(fn, arg)`, which (per the
 * Playwright API) accepts exactly one `arg` value for the whole call: a
 * third positional argument is silently dropped, not forwarded as a second
 * function parameter. `freezeFrame`/`initialBindMode` are therefore
 * delivered together as one destructured object, not as separate
 * positional arguments (an earlier version of this harness passed them
 * positionally; Playwright silently dropped `initialBindMode`, so the bind
 * mode was never actually applied and both counterfactual modes measured
 * identically -- see `docs/browser-profiling.md`'s upstream-investigation
 * section for that history).
 *
 * `initialBindMode` (optional): if a number, applied via the real exported
 * `wasm_exports.alloc_profile_set_bind_mode` from *inside* this file's own
 * overridden `requestAnimationFrame`, on its first invocation, strictly
 * before that first call schedules a real frame. `js/gl.js` assigns
 * `wasm_exports = exports` before calling `exports.main()`, and `main()`
 * calls `requestAnimationFrame` synchronously as its first scheduling step,
 * so this override's first invocation is guaranteed to run after
 * `wasm_exports` exists and strictly before any real animation-frame
 * callback (and therefore before any `wasm_exports.frame()` call) fires.
 * Setting the mode here, rather than via a later `page.evaluate` after
 * `goto`/`waitForFunction`, cannot race the first frame.
 *
 * Freeze-time pixel capture must also happen *synchronously inside this
 * override*, not via a later, separate `page.evaluate` round-trip. The
 * canvas's WebGL context is created with the default
 * `preserveDrawingBuffer: false` (see `js/gl.js`), so the browser is free
 * to invalidate/clear the drawing buffer's contents as soon as it
 * composites a presented frame; a `page.evaluate`-based `gl.readPixels`
 * call made afterwards, as a separate CDP round-trip, is not guaranteed to
 * still see that frame's real content (observed in practice: an
 * all-zero/blank readback with `gl.getError() === 0`, i.e. no error, just
 * stale/cleared data). `js/gl.js`'s own render loop (`animation()`) calls
 * `wasm_exports.frame()` and then calls `window.requestAnimationFrame`
 * again *synchronously, in the same call stack, before yielding to the
 * browser's compositor* -- so this override's freeze branch, reached from
 * that same synchronous call, is the last point guaranteed to still see
 * the just-drawn frame's real pixels. The capture below therefore happens
 * right there, not later.
 */
export function pageInstrumentation({ freezeFrame, initialBindMode, allocWindowPlan = [] }) {
    window.__perf = {
      frameIntervals: [], cpuFrameMs: [], firstDrawMs: null, firstWasmFrameCallbackMs: null,
      bufferUploadCalls: 0, bufferUploadBytes: 0, textureUploadCalls: 0, textureUploadBytes: 0,
      bindTextureCalls: 0, drawCalls: 0, frozenAtFrame: null, bindModeConfiguredAtFrame: null,
      fatalError: null, frozenFramePixels: null, frozenFrameSize: null,
      allocWindowSnapshots: {},
    };
    // Shared, strict framebuffer readback. Invoked exactly once per page,
    // synchronously, from this override's own freeze branch below (see
    // this function's doc comment for why it must run there and not from
    // a later, separate `page.evaluate`); every Node-side call site in
    // this file (`runOnce`/`runBindCacheCounterfactual`) then just reads
    // the already-captured `window.__perf.frozenFramePixels`. Earlier
    // versions of each call site ran their own
    // `try { gl.readPixels(...) } catch { /* left empty */ }` around a
    // pre-zeroed buffer: a thrown `readPixels` (including a lost GL
    // context) was silently swallowed and the untouched all-zero buffer was
    // returned and compared as if it were a real frame -- which could
    // report false pixel parity between two runs that both actually failed
    // to read anything. This single, injected implementation instead fails
    // loudly on every known failure mode: a thrown `readPixels` call, a
    // lost WebGL context, a non-`NO_ERROR` `gl.getError()` after the call,
    // and (specific to this fixture, which always renders a non-uniform
    // checkerboard texture over a clear color) a fully blank/constant
    // readback that would indicate nothing was actually drawn. It also
    // reads the canvas's *actual* `width`/`height` rather than a
    // hardcoded/guessed viewport size, so a resize or DPI difference can
    // never silently truncate or corrupt the comparison.
    window.__readFramebufferPixelsStrict = function readFramebufferPixelsStrict() {
      if (typeof gl === "undefined" || gl === null) {
        throw new Error("readFramebufferPixelsStrict: no WebGL context (gl) is defined on this page");
      }
      if (typeof gl.isContextLost === "function" && gl.isContextLost()) {
        throw new Error("readFramebufferPixelsStrict: WebGL context is lost");
      }
      const width = canvas.width, height = canvas.height;
      if (!(width > 0) || !(height > 0)) {
        throw new Error("readFramebufferPixelsStrict: canvas has non-positive dimensions (" + width + "x" + height + ")");
      }
      const pixels = new Uint8Array(width * height * 4);
      try {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      } catch (error) {
        throw new Error("readFramebufferPixelsStrict: gl.readPixels threw: " + (error && error.message ? error.message : String(error)));
      }
      const glError = gl.getError();
      if (glError !== gl.NO_ERROR) {
        throw new Error("readFramebufferPixelsStrict: gl.getError() reported " + glError + " after gl.readPixels");
      }
      let allSame = true;
      for (let i = 4; i < pixels.length; i += 4) {
        if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] ||
            pixels[i + 2] !== pixels[2] || pixels[i + 3] !== pixels[3]) {
          allSame = false;
          break;
        }
      }
      if (allSame) {
        throw new Error(
          "readFramebufferPixelsStrict: every pixel has RGBA " + Array.from(pixels.subarray(0, 4)).join(",") + "; this fixture always " +
          "renders a non-uniform checkerboard texture over a clear color, so a fully constant " +
          "readback means nothing was actually drawn (lost context, wrong framebuffer, or a " +
          "swallowed upstream failure)",
        );
      }
      return { pixels: Array.from(pixels), width, height };
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
      if (window.__perf.bindModeConfiguredAtFrame === null) {
        // First-ever call: guaranteed to run before any real frame (see
        // this function's doc). Apply the requested bind mode here, race-
        // free, rather than via a later page.evaluate. A specific mode was
        // requested here only if `initialBindMode` is a number: in that
        // case the export MUST exist and be callable, or this run cannot
        // actually be testing the requested mode at all. An earlier
        // version of this guard silently marked
        // `bindModeConfiguredAtFrame` as configured even when the export
        // was missing, which could make a run that measured the Rust-side
        // default mode look like a successfully configured one.
        if (typeof initialBindMode === "number") {
          if (typeof wasm_exports !== "object" || typeof wasm_exports.alloc_profile_set_bind_mode !== "function") {
            const message = "pageInstrumentation: initialBindMode=" + initialBindMode + " was requested but " +
              "wasm_exports.alloc_profile_set_bind_mode is missing or not a function; refusing to silently " +
              "mark the bind mode as configured.";
            window.__perf.fatalError = message;
            throw new Error(message);
          }
          wasm_exports.alloc_profile_set_bind_mode(initialBindMode);
        }
        window.__perf.bindModeConfiguredAtFrame = window.__perf.frameIntervals.length;
      }
      {
        // Synchronous, in-loop window-boundary snapshot: runs at the exact
        // instant `frameIntervals.length` equals a plan entry's `frame`,
        // never via a later Node-side poll + separate `evaluate` (which
        // can race past the boundary; see `ALLOC_WINDOW_PLAN`'s doc
        // comment). Entries sharing a `frame` run back-to-back here, in
        // array order, with zero elapsed frames between them.
        const currentFrame = window.__perf.frameIntervals.length;
        for (const entry of allocWindowPlan) {
          if (entry.frame !== currentFrame || window.__perf.allocWindowSnapshots[entry.name]) continue;
          const exportsReady = typeof wasm_exports === "object" &&
            typeof wasm_exports.alloc_profile_current_alloc_calls === "function" &&
            typeof wasm_exports.alloc_profile_current_realloc_calls === "function" &&
            typeof wasm_exports.alloc_profile_current_dealloc_calls === "function" &&
            typeof wasm_exports.alloc_profile_current_live_bytes === "function" &&
            typeof wasm_exports.alloc_profile_current_peak_bytes === "function" &&
            (!entry.resetPeak || typeof wasm_exports.alloc_profile_reset_peak === "function");
          if (!exportsReady) {
            const message = "pageInstrumentation: allocWindowPlan entry '" + entry.name + "' at frame " +
              entry.frame + " requires wasm_exports.alloc_profile_* exports that are missing or not " +
              "callable; refusing to silently skip this window boundary.";
            window.__perf.fatalError = message;
            throw new Error(message);
          }
          if (entry.resetPeak) wasm_exports.alloc_profile_reset_peak();
          window.__perf.allocWindowSnapshots[entry.name] = {
            frame: currentFrame,
            counters: {
              allocCalls: Number(wasm_exports.alloc_profile_current_alloc_calls()),
              reallocCalls: Number(wasm_exports.alloc_profile_current_realloc_calls()),
              deallocCalls: Number(wasm_exports.alloc_profile_current_dealloc_calls()),
              liveBytes: Number(wasm_exports.alloc_profile_current_live_bytes()),
              peakBytes: Number(wasm_exports.alloc_profile_current_peak_bytes()),
            },
          };
        }
      }
      if (window.__perf.frameIntervals.length >= freezeFrame) {
        // Capture the just-drawn frame's real pixels synchronously, right
        // here, before returning -- see this function's doc comment for
        // why a later, separate `page.evaluate`-based `gl.readPixels` call
        // cannot reliably see this frame's content once
        // `preserveDrawingBuffer: false` lets the browser invalidate it.
        try {
          const framebuffer = window.__readFramebufferPixelsStrict();
          window.__perf.frozenFramePixels = framebuffer.pixels;
          window.__perf.frozenFrameSize = { width: framebuffer.width, height: framebuffer.height };
        } catch (error) {
          window.__perf.fatalError = "freeze-time pixel capture failed: " +
            (error && error.message ? error.message : String(error));
        }
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

/**
 * Waits for the frozen-frame signal set by `pageInstrumentation`'s
 * `requestAnimationFrame` override, but fails fast (within the same
 * bounded `WAIT_TIMEOUT_MS`) and with a clear message instead of a bare
 * timeout if `window.__perf.fatalError` was set first (for example, an
 * `initialBindMode` requested without the required WASM export, or a
 * failed freeze-time pixel capture -- see `pageInstrumentation`'s doc
 * comment).
 */
async function waitForFreezeOrFatalError(page) {
  await page.waitForFunction(
    () => window.__perf.frozenAtFrame !== null || window.__perf.fatalError,
    null, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
  );
  const fatalError = await page.evaluate(() => window.__perf.fatalError);
  if (fatalError) throw new Error(fatalError);
}

async function runOnce(playwright, serverUrl, variant, freezeFrame) {
  const browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    await page.addInitScript(pageInstrumentation, { freezeFrame });
    await page.goto(`${serverUrl}/?variant=${variant}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => typeof wasm_exports === "object" && typeof wasm_exports.frame === "function",
      null, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
    );
    await page.evaluate(() => {
      const original = wasm_exports;
      wasm_exports = { ...original, frame(...args) {
        const before = performance.now();
        try { return original.frame(...args); } finally { window.__perf.cpuFrameMs.push(performance.now() - before); }
      } };
    });
    await page.waitForFunction(
      (needed) => (window.__perf.frozenAtFrame !== null && window.__perf.cpuFrameMs.length >= needed) || window.__perf.fatalError,
      CPU_SAMPLES, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
    );
    await page.waitForTimeout(150); // let other perf counters settle; pixels were already captured synchronously at freeze time
    const metrics = await page.evaluate(() => {
      if (window.__perf.fatalError) throw new Error(window.__perf.fatalError);
      if (!window.__perf.frozenFramePixels || !window.__perf.frozenFrameSize) {
        throw new Error("runOnce: no frozen-frame pixels were captured (pageInstrumentation's freeze branch never ran)");
      }
      const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        perf: window.__perf,
        jsHeapUsedBytes: heap,
        jsHeapReason: heap === null ? "performance.memory unavailable in this engine/mode" : null,
        wasmMemoryBytes: typeof wasm_memory === "object" ? wasm_memory.buffer.byteLength : null,
        pixels: window.__perf.frozenFramePixels,
        canvasSize: window.__perf.frozenFrameSize,
      };
    });
    const cpuProfile = (await cdp.send("Profiler.stop")).profile;
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
      allocationProfiling: { available: false, reason: "This timing-pair run does not sample allocations; see the top-level `allocationProfile` field (runAllocationProfile) for real counters and CDP HeapProfiler sampling." },
      cpuProfileTopNodes: topCpuProfileNodes(cpuProfile, 5),
      pixelsBase64: Buffer.from(metrics.pixels).toString("base64"),
      canvasSize: metrics.canvasSize,
    };
  } finally {
    // try/finally so a thrown error (for example, a waitForFunction
    // timeout) can never leak a headless Chromium process.
    await browser.close();
  }
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

// A real contamination was found and fixed by this check: an earlier run
// accidentally rebuilt the alloc-profile-cfg-gated WASM into the default
// target dir, silently overwriting BASELINE_WASM with a binary exporting
// the `alloc_profile` module's functions, which bind a different texture
// at the comparison frame than CANDIDATE_WASM's unmodified fixture logic
// (not a real baseline/candidate behavior difference). This check parses
// the module with `WebAssembly.Module` and inspects its real export
// table for an `alloc_profile_`-prefixed name, so a marker string that
// merely appears in a custom/data section (not an actual export) cannot
// cause a false positive, and malformed bytes fail loudly instead of
// silently passing.
export function assertNotAllocProfileContaminated(wasmBytes, label) {
  let module;
  try {
    module = new WebAssembly.Module(wasmBytes);
  } catch (err) {
    throw new Error(
      `assertNotAllocProfileContaminated: ${label} is not a valid WASM module: ${err.message}`,
    );
  }
  const forbidden = WebAssembly.Module.exports(module).find((exp) => exp.name.startsWith("alloc_profile_"));
  if (forbidden) {
    throw new Error(
      `assertNotAllocProfileContaminated: ${label} WASM exports ` +
      `'${forbidden.name}', meaning this build was accidentally produced ` +
      "with `--cfg miniquad_alloc_profile` (or built into the wrong " +
      "target dir, overwriting it with that build). The baseline/candidate " +
      "timing-pair comparison must never run against the alloc-profile-" +
      "instrumented binary: rebuild with the exact command documented in " +
      "docs/browser-profiling.md.",
    );
  }
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

/**
 * Validates the four `allocWindowSnapshots` captured synchronously
 * in-page by `ALLOC_WINDOW_PLAN`'s `requestAnimationFrame`-override hook,
 * and builds the `windowA`/`windowB` report sections from them. Throws
 * (never silently clamps or substitutes a guessed value) if any snapshot
 * is missing, or if its recorded frame index does not exactly match its
 * plan entry, or if the resulting windows are not exactly
 * `STEADY_WINDOW_FRAMES` long and adjacent with no gap or overlap. This
 * is the explicit assertion requested in place of trusting a
 * `page.waitForFunction(() => ... >= n)` race to have landed on the
 * intended frame.
 */
export function buildAllocationWindows(snapshots) {
  for (const entry of ALLOC_WINDOW_PLAN) {
    const snapshot = snapshots?.[entry.name];
    if (!snapshot) {
      throw new Error(`buildAllocationWindows: missing snapshot '${entry.name}' (expected at frame ${entry.frame})`);
    }
    if (snapshot.frame !== entry.frame) {
      throw new Error(
        `buildAllocationWindows: snapshot '${entry.name}' was captured at frame ${snapshot.frame}, ` +
        `expected exactly ${entry.frame}`,
      );
    }
  }
  const windowALength = snapshots.windowAEnd.frame - snapshots.windowAStart.frame;
  const windowBLength = snapshots.windowBEnd.frame - snapshots.windowBStart.frame;
  if (windowALength !== STEADY_WINDOW_FRAMES || windowBLength !== STEADY_WINDOW_FRAMES) {
    throw new Error(
      `buildAllocationWindows: window lengths were windowA=${windowALength}, windowB=${windowBLength}; ` +
      `expected exactly ${STEADY_WINDOW_FRAMES} frames each`,
    );
  }
  if (snapshots.windowAEnd.frame !== snapshots.windowBStart.frame) {
    throw new Error(
      "buildAllocationWindows: windowA and windowB must be adjacent with zero gap or overlap " +
      `(windowAEnd.frame=${snapshots.windowAEnd.frame}, windowBStart.frame=${snapshots.windowBStart.frame})`,
    );
  }
  return {
    windowA: {
      startFrame: snapshots.windowAStart.frame,
      endFrame: snapshots.windowAEnd.frame,
      start: snapshots.windowAStart.counters,
      end: snapshots.windowAEnd.counters,
      delta: allocationPhaseDelta(snapshots.windowAStart.counters, snapshots.windowAEnd.counters),
      // Absolute in-window peak: reset_peak() rebased PEAK_BYTES to
      // LIVE_BYTES right before this window started, so this is the true
      // max reached strictly within this window, not a diff of two
      // global watermarks.
      peakBytesInWindow: snapshots.windowAEnd.counters.peakBytes,
    },
    windowB: {
      startFrame: snapshots.windowBStart.frame,
      endFrame: snapshots.windowBEnd.frame,
      start: snapshots.windowBStart.counters,
      end: snapshots.windowBEnd.counters,
      delta: allocationPhaseDelta(snapshots.windowBStart.counters, snapshots.windowBEnd.counters),
      peakBytesInWindow: snapshots.windowBEnd.counters.peakBytes,
    },
  };
}

/**
 * Real Rust allocation counters plus real CDP `HeapProfiler` sampling, for
 * the isolated `alloc-profile` WASM build (see `ALLOC_PROFILE_WASM`).
 *
 * Reports two **equal-length steady-phase** windows (`STEADY_WINDOW_FRAMES`
 * each), both starting only after `WARMUP_FRAMES` have run so cold-start
 * allocation (typically heavier, not representative of repeated per-frame
 * behavior) is excluded. `alloc_profile_reset_peak()` (a real exported
 * WASM call) is invoked immediately before each window starts, so each
 * window's `peakBytes` reading is an absolute "peak reached strictly
 * within this window" value, never a diff between two unrelated
 * process-wide watermarks. Comparing the two equal windows' deltas
 * supports a bounded "did net live bytes grow between two equivalent
 * repeated-frame windows" observation; a single window can never support
 * that claim by itself.
 *
 * CDP `HeapProfiler.startSampling` is also started, but it instruments
 * only V8's own JS/managed heap — it has no visibility into a WASM
 * module's linear memory or its internal (Rust) allocator, so no Rust
 * `alloc`/`dealloc` call site can ever appear in `topSelfSizeNodes` here,
 * regardless of `samplingInterval`. This is a tooling-capability limit,
 * not a resolution/coarseness artifact; see `docs/browser-profiling.md`.
 *
 * Returns `{available: false, reason}` if the alloc-profile build was
 * never run, or if a measurement precondition (export presence, frame
 * progress) was not met.
 */
export async function runAllocationProfile(playwright, serverUrl, freezeFrame) {
  if (!existsSync(ALLOC_PROFILE_WASM)) {
    return {
      available: false,
      reason: "alloc-profile WASM build not found; build it first with " +
        "RUSTFLAGS=\"--cfg miniquad_alloc_profile\" cargo build --release " +
        "--target wasm32-unknown-unknown --example browser_perf " +
        "--target-dir target/alloc-profile-experiment",
    };
  }
  const browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    // samplingInterval only trades sampling density for overhead within
    // the JS/managed heap HeapProfiler already instruments; it does not
    // and cannot extend that instrumentation into WASM linear memory (see
    // this function's doc).
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384 });
    await page.addInitScript(pageInstrumentation, { freezeFrame, allocWindowPlan: ALLOC_WINDOW_PLAN });
    await page.goto(`${serverUrl}/?variant=alloc-profile`, { waitUntil: "load" });
    await page.waitForFunction(
      () => typeof wasm_exports === "object" && typeof wasm_exports.alloc_profile_available === "function",
      null, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
    );
    const available = await page.evaluate(() => Number(wasm_exports.alloc_profile_available()));
    if (available !== 1) {
      return { available: false, reason: "alloc_profile_available() did not return 1; export missing or build mismatch" };
    }
    const initCounters = await page.evaluate(() => ({
      allocCalls: Number(wasm_exports.alloc_profile_init_alloc_calls()),
      reallocCalls: Number(wasm_exports.alloc_profile_init_realloc_calls()),
      deallocCalls: Number(wasm_exports.alloc_profile_init_dealloc_calls()),
      liveBytes: Number(wasm_exports.alloc_profile_init_live_bytes()),
      peakBytes: Number(wasm_exports.alloc_profile_init_peak_bytes()),
    }));
    const selftestRaw = await page.evaluate(() => Number(wasm_exports.alloc_profile_selftest_result()));

    // Window boundaries are captured synchronously in-page by
    // `pageInstrumentation`'s own `requestAnimationFrame` override (see
    // `ALLOC_WINDOW_PLAN`), never by Node polling `frameIntervals.length`
    // and then racing a separate `evaluate` against the page's own render
    // loop. This wait only needs to block until the run has frozen (or
    // failed); the window snapshots themselves are already complete and
    // exact by the time that happens.
    await waitForFreezeOrFatalError(page);
    await page.waitForTimeout(150); // let the freeze settle before reading the sampling profile
    const framesCounted = await page.evaluate(() => window.__perf.frameIntervals.length);
    const snapshots = await page.evaluate(() => window.__perf.allocWindowSnapshots);
    const samplingProfile = (await cdp.send("HeapProfiler.stopSampling")).profile;
    const { windowA, windowB } = buildAllocationWindows(snapshots);

    return {
      available: true,
      selftest: decodeSelftestResult(selftestRaw),
      init: initCounters,
      framesCounted,
      steadyWindowFrames: STEADY_WINDOW_FRAMES,
      warmupFrames: WARMUP_FRAMES,
      windowA,
      windowB,
      heapSampling: {
        available: !!samplingProfile?.head,
        topSelfSizeNodes: topHeapSamplingNodes(samplingProfile, 10),
        note: "CDP HeapProfiler samples only the JS/V8 heap; it has no visibility " +
          "into WASM linear memory, so it can never show a Rust alloc/dealloc call " +
          "site here regardless of samplingInterval. Any entries above are JS-side " +
          "(for example Playwright/page-script activity), not Rust allocations.",
      },
      note: "windowA/windowB are two equal-length (" + STEADY_WINDOW_FRAMES + "-frame) steady-phase " +
        "windows after a " + WARMUP_FRAMES + "-frame warmup, with exact startFrame/endFrame indices " +
        "captured synchronously in-page (never inferred from a Node-side poll); each delta is a " +
        "total over its own window, never a rate. Comparing windowA.delta to windowB.delta supports " +
        "a bounded repeated-frame net-bytes observation; this is not a single-window 'no leak' claim.",
    };
  } finally {
    await browser.close();
  }
}

/**
 * Real-browser counterfactual for upstream not-fl3/miniquad `#691`
 * (`GlCache::forget_texture`, `src/graphics/gl/cache.rs`: forgetting a
 * *deleted* texture's cached slot so a later GL-name reuse by a new
 * texture is not wrongly treated as "already bound"). This is distinct
 * from simple cross-frame bind dedup: `GlCache::bind_texture`'s dedup
 * already resets every frame via `commit_frame -> clear_texture_bindings`
 * in this fixture's single-pass-per-frame structure, so a cross-frame
 * identical-vs-alternating comparison alone can never reach a real cache
 * hit and must never be read as evidence about `forget_texture`.
 *
 * Two real experiments, each a fresh page load (fresh `GlCache`, no
 * cross-run counter leakage):
 *
 * 1. Within-pass bind sequence: `alloc_profile_set_bind_mode` (applied
 *    race-free before frame 0, see `pageInstrumentation`'s doc) selects 4
 *    `apply_bindings` calls before 1 draw, per frame: mode 0 = "repeat"
 *    (A,A,A,A -- 3 real cache hits expected), mode 1 = "alternate"
 *    (A,B,B,A -- only the middle B,B repeat is expected to hit). Both
 *    sequences end on texture_a, so rendered pixels must be identical
 *    between modes; real WebGL `bindTexture` call counts and frozen
 *    pixels are both recorded to support that parity claim.
 * 2. Delete/create/rebind: `alloc_profile_request_delete_recreate` (a
 *    real one-shot exported WASM call) triggers, on the next frame, a
 *    bind -> delete_texture -> new_texture_from_rgba8 (identical content)
 *    -> rebind sequence in `Stage::draw`. `alloc_profile_delete_recreate_
 *    applied_at_frame` is read back to confirm the one-shot request was
 *    actually consumed (not silently missed), and render/bind counts and
 *    frozen pixels are recorded.
 *
 * Honest limit: whether the browser's GL actually reuses texture_a's
 * freed numeric name for the new texture is driver/engine-dependent and
 * not controlled by this fixture. A real bind call being recorded after
 * delete/create/rebind is consistent with `forget_texture` correctly
 * invalidating the cache slot on delete, but is not deterministic proof of
 * the specific name-reuse collision scenario `forget_texture` guards
 * against. A cross-frame 0 bindTexture-call-reduction is never cited here
 * as proof of `forget_texture`'s behavior.
 */
export async function runBindCacheCounterfactual(playwright, serverUrl, freezeFrame) {
  if (!existsSync(ALLOC_PROFILE_WASM)) {
    return {
      available: false,
      reason: "alloc-profile WASM build not found; see runAllocationProfile's reason for the build command.",
    };
  }
  async function runSequenceMode(mode) {
    const browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.addInitScript(pageInstrumentation, { freezeFrame, initialBindMode: mode });
      await page.goto(`${serverUrl}/?variant=alloc-profile`, { waitUntil: "load" });
      await waitForFreezeOrFatalError(page);
      await page.waitForTimeout(150);
      const perf = await page.evaluate(() => ({
        bindTextureCalls: window.__perf.bindTextureCalls,
        drawCalls: window.__perf.drawCalls,
        framesCounted: window.__perf.frameIntervals.length,
        bindModeConfiguredAtFrame: window.__perf.bindModeConfiguredAtFrame,
      }));
      // Pixels were already captured synchronously inside
      // `pageInstrumentation`'s freeze branch (actual canvas dimensions,
      // never a hardcoded/guessed VIEWPORT size), because this canvas's
      // WebGL context uses the default `preserveDrawingBuffer: false`: a
      // separate `gl.readPixels` call made now, as its own CDP round-trip,
      // is not guaranteed to still see that frame's real content. This
      // just reads back the already-captured, already-validated array.
      const framebuffer = await page.evaluate(() => ({ pixels: window.__perf.frozenFramePixels, size: window.__perf.frozenFrameSize }));
      if (!framebuffer.pixels || !framebuffer.size) {
        throw new Error("runSequenceMode: no frozen-frame pixels were captured (pageInstrumentation's freeze branch never ran)");
      }
      return { ...perf, pixelsBase64: Buffer.from(framebuffer.pixels).toString("base64"), canvasSize: framebuffer.size };
    } finally {
      await browser.close();
    }
  }
  async function runDeleteRecreateProbe() {
    const browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.addInitScript(pageInstrumentation, { freezeFrame });
      await page.goto(`${serverUrl}/?variant=alloc-profile`, { waitUntil: "load" });
      await page.waitForFunction(
        () => typeof wasm_exports === "object" && typeof wasm_exports.alloc_profile_request_delete_recreate === "function",
        null, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
      );
      const bindTextureCallsBefore = await page.evaluate(() => window.__perf.bindTextureCalls);
      await page.evaluate(() => wasm_exports.alloc_profile_request_delete_recreate());
      await page.waitForFunction(
        () => Number(wasm_exports.alloc_profile_delete_recreate_applied_at_frame()) >= 0,
        null, { timeout: WAIT_TIMEOUT_MS, polling: 50 },
      );
      const appliedAtFrame = await page.evaluate(() => Number(wasm_exports.alloc_profile_delete_recreate_applied_at_frame()));
      await waitForFreezeOrFatalError(page);
      await page.waitForTimeout(150);
      const bindTextureCallsAfter = await page.evaluate(() => window.__perf.bindTextureCalls);
      const framebuffer = await page.evaluate(() => ({ pixels: window.__perf.frozenFramePixels, size: window.__perf.frozenFrameSize }));
      if (!framebuffer.pixels || !framebuffer.size) {
        throw new Error("runDeleteRecreateProbe: no frozen-frame pixels were captured (pageInstrumentation's freeze branch never ran)");
      }
      return {
        appliedAtFrame,
        bindTextureCallsAfterRequest: bindTextureCallsAfter - bindTextureCallsBefore,
        pixelsBase64: Buffer.from(framebuffer.pixels).toString("base64"),
        canvasSize: framebuffer.size,
      };
    } finally {
      await browser.close();
    }
  }

  const repeat = await runSequenceMode(0);
  const alternate = await runSequenceMode(1);
  const deleteRecreate = await runDeleteRecreateProbe();

  const sequenceParity = pixelParity(
    Buffer.from(repeat.pixelsBase64, "base64"),
    Buffer.from(alternate.pixelsBase64, "base64"),
    2,
  );
  // `runDeleteRecreateProbe` does not configure a bind mode (it runs the
  // Rust-side default, mode 0 = "repeat"), uses the same `freezeFrame`,
  // and its one-shot delete/recreate rebinds onto a freshly-created
  // `texture_a` with byte-identical checkerboard content, so its final
  // frame is expected to be pixel-identical to `repeat`'s. An earlier
  // version of this probe recorded this same-image reference pixel data
  // internally but discarded it before returning, so no parity result
  // was ever reported despite the module's own doc comment implying one.
  const deleteRecreateParityVsRepeat = pixelParity(
    Buffer.from(repeat.pixelsBase64, "base64"),
    Buffer.from(deleteRecreate.pixelsBase64, "base64"),
    2,
  );

  return {
    available: true,
    withinPassSequence: {
      repeat: { bindTextureCalls: repeat.bindTextureCalls, drawCalls: repeat.drawCalls, framesCounted: repeat.framesCounted, bindModeConfiguredAtFrame: repeat.bindModeConfiguredAtFrame },
      alternate: { bindTextureCalls: alternate.bindTextureCalls, drawCalls: alternate.drawCalls, framesCounted: alternate.framesCounted, bindModeConfiguredAtFrame: alternate.bindModeConfiguredAtFrame },
      bindTextureCallsPerFrame: {
        repeat: repeat.framesCounted > 0 ? repeat.bindTextureCalls / repeat.framesCounted : null,
        alternate: alternate.framesCounted > 0 ? alternate.bindTextureCalls / alternate.framesCounted : null,
      },
      pixelParity: sequenceParity,
      note: "4 apply_bindings calls per frame, 1 final draw. 'repeat' (A,A,A,A) is expected " +
        "to show fewer real bindTexture calls per frame than 'alternate' (A,B,B,A) because " +
        "GlCache::bind_texture's dedup is reached for the 3 (repeat) vs 1 (alternate, the " +
        "middle B,B) consecutive same-texture binds within this uncommitted pass. Both " +
        "sequences end on texture_a, so pixelParity.mismatchedPixelRatio === 0 is the " +
        "expected result confirming this is a bind-count counterfactual, not a pixel change.",
    },
    deleteRecreateProbe: {
      appliedAtFrame: deleteRecreate.appliedAtFrame,
      bindTextureCallsAfterRequest: deleteRecreate.bindTextureCallsAfterRequest,
      pixelParityVsRepeat: deleteRecreateParityVsRepeat,
      note: "One-shot bind -> delete_texture -> new_texture_from_rgba8(identical content) -> " +
        "rebind, triggered mid-run via a real exported WASM call. bindTextureCallsAfterRequest " +
        "includes at least the 2 real binds this probe always performs (texture_a before " +
        "delete, the new texture after recreate); it does not by itself prove GL reused " +
        "texture_a's freed numeric name (browser/driver-dependent, not controlled here), so " +
        "this is reported as a render/bind-count/parity observation, not as a deterministic " +
        "proof of the specific name-reuse collision forget_texture guards against. A 0 value " +
        "here would indicate a harness fault (the one-shot request not reaching Stage::draw), " +
        "not evidence against forget_texture, and appliedAtFrame >= 0 is checked to rule that " +
        "out explicitly. pixelParityVsRepeat compares this probe's final frame against the " +
        "same-image reference `repeat` run above (same freezeFrame, same default bind mode, " +
        "both ending on a texture_a with byte-identical checkerboard content): " +
        "mismatchedPixelRatio === 0 here means the delete/recreate/rebind sequence rendered " +
        "the same final image as a run that never deleted anything, which is the meaningful " +
        "parity claim this probe can actually support.",
    },
    note: "Mode/requests are applied via real exported WASM functions, never by mutating " +
      "WASM state from JS. This is a labeled, benchmark-only counterfactual on the existing " +
      "GlCache::bind_texture/forget_texture contract (src/graphics/gl/cache.rs), not a change " +
      "to it; the default (non-cfg) build never links this module.",
  };
}


async function main() {
  const playwrightEntry = resolvePlaywrightEntry();
  const playwright = localRequire(playwrightEntry);
  const server = await startServer();
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const pairCount = Number(process.env.MINIQUAD_PROFILE_PAIRS || 5);
  let pairs, allocationProfile, bindCacheCounterfactual;
  try {
    pairs = [];
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
      const order = pairIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      const runs = {};
      for (const variant of order) runs[variant] = await runOnce(playwright, serverUrl, variant, FREEZE_FRAME);
      pairs.push({ pairIndex, order, baseline: runs.baseline, candidate: runs.candidate });
    }
    allocationProfile = await runAllocationProfile(playwright, serverUrl, FREEZE_FRAME);
    bindCacheCounterfactual = await runBindCacheCounterfactual(playwright, serverUrl, FREEZE_FRAME);
  } finally {
    // Always close the HTTP server, including when a measurement above
    // throws (for example, a fatal error surfaced from pageInstrumentation
    // or buildAllocationWindows): an earlier version only called
    // `server.close()` on the success path, which could leak the server's
    // listening socket across a failed/aborted run.
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
  }

  const provenance = sourceProvenance();
  const baselineBytes = readFileSync(BASELINE_WASM);
  const candidateBytes = readFileSync(CANDIDATE_WASM);
  assertNotAllocProfileContaminated(baselineBytes, "BASELINE_WASM");
  assertNotAllocProfileContaminated(candidateBytes, "CANDIDATE_WASM");
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
    allocationProfile,
    bindCacheCounterfactual,
    sourceProvenance: provenance,
    limitations: "Warm headless software-GPU samples, not a GPU-timer or real-device measurement. GPU completion time is not collected and is never reported as zero.",
  };

  const outDir = process.env.MINIQUAD_PROFILE_OUT_DIR || resolve(repoRoot, "test-results");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `browser-profile-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log("Wrote raw browser profile receipt to", outFile);
  console.log(JSON.stringify({ sizes, comparisons, pixelParity: parity, allocationProfile, bindCacheCounterfactual, sourceProvenance: provenance }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
