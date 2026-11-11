import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  percentile,
  validateSamples,
  aggregate,
  pairDelta,
  summarizePairs,
  compressionReport,
  pixelParity,
  allocationPhaseDelta,
  decodeSelftestResult,
  topHeapSamplingNodes,
  pageInstrumentation,
  ALLOC_WINDOW_PLAN,
  buildAllocationWindows,
  assertNotAllocProfileContaminated,
} from "../scripts/profile-browser.mjs";

/**
 * Runs the real, deployed `pageInstrumentation` source (the exact function
 * value passed to `page.addInitScript`, via `.toString()` -- never a
 * hand-copied duplicate that could drift from it) inside a sandboxed Node
 * `vm` context standing in for a browser page. `overrides` supplies fake
 * `gl`/`canvas`/`wasm_exports` (and anything else `pageInstrumentation`
 * reads as a bare global); `options` is the `{ freezeFrame, initialBindMode }`
 * argument `page.addInitScript` would pass through. Returns the contextified
 * sandbox, whose `window` is the sandbox itself (so `sandbox.window.__perf`,
 * `sandbox.window.__readFramebufferPixelsStrict`, and
 * `sandbox.window.requestAnimationFrame` are all reachable post-run).
 */
function runPageInstrumentation(overrides, options) {
  const sandbox = {
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    WebGLRenderingContext: undefined,
    WebGL2RenderingContext: undefined,
    ...overrides,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(`(${pageInstrumentation.toString()})(${JSON.stringify(options)})`, context);
  return context;
}

function fakeGl(overrides = {}) {
  return {
    isContextLost: () => false,
    readPixels: () => {},
    getError: () => 0,
    NO_ERROR: 0,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    ...overrides,
  };
}

test("percentile selects the nearest-rank value and handles empty input", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 0.5), 5);
  assert.equal(percentile(sorted, 0.95), 10);
  assert.equal(percentile([], 0.5), null);
});

test("validateSamples drops non-finite and missing values with reasons", () => {
  const result = validateSamples([1, 2, NaN, undefined, Infinity, 3]);
  assert.deepEqual(result.valid, [1, 2, 3]);
  assert.equal(result.droppedCount, 3);
  assert.deepEqual(result.droppedReasons, ["NaN", "missing", "Infinity"]);
});

test("validateSamples tolerates an undefined/empty sample list", () => {
  assert.deepEqual(validateSamples(undefined), { valid: [], droppedCount: 0, droppedReasons: [] });
});

test("aggregate reports count, dropped count and percentiles together", () => {
  const result = aggregate([10, 20, null, 30, 40]);
  assert.equal(result.count, 4);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.p50, 20);
  assert.equal(result.p99, 40);
});

test("pairDelta computes signed bytes and percent change", () => {
  const delta = pairDelta(100, 90);
  assert.equal(delta.bytes, -10);
  assert.equal(delta.percent, -10);
  assert.equal(delta.reason, null);
});

test("pairDelta reports a reason instead of a fabricated value for missing samples", () => {
  const delta = pairDelta(100, null);
  assert.equal(delta.bytes, null);
  assert.equal(delta.percent, null);
  assert.match(delta.reason, /missing/);
});

test("pairDelta avoids dividing by a zero baseline", () => {
  const delta = pairDelta(0, 5);
  assert.equal(delta.bytes, 5);
  assert.equal(delta.percent, null);
});

test("summarizePairs reports INCONCLUSIVE when noise spread hides the median delta", () => {
  const deltas = [-5, 4, -3, 6, -4]; // spread (11) exceeds |median| (-4 -> 4)
  const result = summarizePairs(deltas);
  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.sampleCount, 5);
});

test("summarizePairs reports MEASURED when the median delta dominates the spread", () => {
  const deltas = [-20, -21, -19, -20, -22];
  const result = summarizePairs(deltas);
  assert.equal(result.verdict, "MEASURED");
  assert.ok(result.medianDelta < 0);
});

test("summarizePairs handles an all-missing delta list without throwing", () => {
  const result = summarizePairs([null, undefined, NaN]);
  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.sampleCount, 0);
  assert.match(result.reason, /no valid pair deltas/);
});

test("compressionReport measures real raw/gzip/Brotli bytes and a stable hash", () => {
  const bytes = Buffer.from("miniquad browser profiling fixture bytes".repeat(50));
  const report = compressionReport(bytes);
  assert.equal(report.rawBytes, bytes.byteLength);
  assert.ok(report.gzipBytes > 0 && report.gzipBytes < report.rawBytes);
  assert.ok(report.brotliBytes > 0 && report.brotliBytes < report.rawBytes);
  assert.equal(report.sha256, compressionReport(bytes).sha256);
});

test("pixelParity flags unequal buffer sizes without reading out of bounds", () => {
  const result = pixelParity(new Uint8Array(8), new Uint8Array(4), 2);
  assert.equal(result.equalSize, false);
  assert.equal(result.maxChannelDiff, null);
});

// Builds a real, minimal, valid WASM module (magic + version + optional
// single zero-arg/zero-result function, optionally exported under
// `exportName`, plus an optional custom section carrying `customPayload`
// as raw bytes) so these regression tests exercise actual
// `WebAssembly.Module` parsing/exports, not a byte-string stand-in.
function buildWasmModule({ exportName, customPayload } = {}) {
  const u32le = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      out.push(byte);
    } while (n !== 0);
    return out;
  };
  const strBytes = (s) => [...Buffer.from(s, "utf8")];
  const section = (id, content) => [id, ...u32le(content.length), ...content];

  const parts = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // magic + version

  if (customPayload) {
    const name = "test-marker";
    const content = [...u32le(name.length), ...strBytes(name), ...strBytes(customPayload)];
    parts.push(...section(0, content)); // custom section, id 0
  }

  if (exportName) {
    parts.push(...section(1, [0x01, 0x60, 0x00, 0x00])); // type section: () -> ()
    parts.push(...section(3, [0x01, 0x00])); // function section: fn 0 uses type 0
    const name = strBytes(exportName);
    parts.push(...section(7, [0x01, ...u32le(name.length), ...name, 0x00, 0x00])); // export section
    parts.push(...section(10, [0x01, 0x02, 0x00, 0x0b])); // code section: empty body, `end`
  }

  return Buffer.from(parts);
}

test("assertNotAllocProfileContaminated throws when a real WASM module exports an alloc_profile_-prefixed name (regression for a real baseline-build mix-up)", () => {
  // This is a real mistake that occurred: `--cfg miniquad_alloc_profile`
  // was built into the default target dir, silently overwriting
  // BASELINE_WASM with the alloc-profile-instrumented binary, which
  // bound a different texture at the comparison frame than
  // CANDIDATE_WASM and produced a false baseline/candidate pixel-
  // mismatch result. This guard must throw on exactly that
  // contamination, not silently let it through.
  const contaminated = buildWasmModule({ exportName: "alloc_profile_available" });
  assert.throws(() => assertNotAllocProfileContaminated(contaminated, "BASELINE_WASM"), /alloc_profile_/);
});

test("assertNotAllocProfileContaminated does not throw when the marker string appears only in a custom/data section, not a real export", () => {
  // A raw byte-scan would false-positive here; the guard must parse the
  // module and check real exports only.
  const module = buildWasmModule({ exportName: "frame", customPayload: "alloc_profile_available" });
  assert.doesNotThrow(() => assertNotAllocProfileContaminated(module, "BASELINE_WASM"));
});

test("assertNotAllocProfileContaminated does not throw on a clean, valid WASM module with no alloc_profile export", () => {
  const clean = buildWasmModule({ exportName: "frame" });
  assert.doesNotThrow(() => assertNotAllocProfileContaminated(clean, "BASELINE_WASM"));
});

test("assertNotAllocProfileContaminated throws explicitly on malformed/non-WASM bytes rather than silently passing", () => {
  const malformed = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  assert.throws(() => assertNotAllocProfileContaminated(malformed, "BASELINE_WASM"), /not a valid WASM module/);
});


test("pixelParity reports zero diff for identical frozen frames", () => {
  const frame = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  const result = pixelParity(frame, frame.slice(), 2);
  assert.equal(result.equalSize, true);
  assert.equal(result.maxChannelDiff, 0);
  assert.equal(result.mismatchedPixelRatio, 0);
});

test("pixelParity counts pixels past tolerance and keeps the rest", () => {
  const baseline = new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255]);
  const candidate = new Uint8Array([0, 0, 0, 255, 150, 100, 100, 255]);
  const result = pixelParity(baseline, candidate, 2);
  assert.equal(result.mismatchedPixelRatio, 0.5);
  assert.equal(result.maxChannelDiff, 50);
});

test("allocationPhaseDelta computes a real-counter total, not a rate", () => {
  const init = { allocCalls: 10, reallocCalls: 0, deallocCalls: 8, liveBytes: 64, peakBytes: 256 };
  const current = { allocCalls: 130, reallocCalls: 0, deallocCalls: 128, liveBytes: 64, peakBytes: 512 };
  const delta = allocationPhaseDelta(init, current);
  assert.equal(delta.available, true);
  assert.equal(delta.allocCalls, 120);
  assert.equal(delta.deallocCalls, 120);
  assert.equal(delta.liveBytesDelta, 0);
  assert.equal(delta.peakBytes, undefined, "peakBytes has separate reset semantics; this function never diffs it");
});

test("allocationPhaseDelta reports unavailable instead of fabricating missing counters", () => {
  const delta = allocationPhaseDelta({ allocCalls: 1 }, { allocCalls: 2 });
  assert.equal(delta.available, false);
  assert.match(delta.reason, /missing counter field/);
});

test("allocationPhaseDelta rejects a call count that moved backwards instead of reporting a bad delta", () => {
  const init = { allocCalls: 10, reallocCalls: 0, deallocCalls: 8, liveBytes: 64 };
  const current = { allocCalls: 9, reallocCalls: 0, deallocCalls: 8, liveBytes: 64 };
  const delta = allocationPhaseDelta(init, current);
  assert.equal(delta.available, false);
  assert.match(delta.reason, /allocCalls decreased from 10 to 9/);
});

test("allocationPhaseDelta reports a real negative liveBytesDelta, never clamped to 0", () => {
  const init = { allocCalls: 50, reallocCalls: 0, deallocCalls: 40, liveBytes: 1000 };
  const current = { allocCalls: 55, reallocCalls: 0, deallocCalls: 48, liveBytes: 600 };
  const delta = allocationPhaseDelta(init, current);
  assert.equal(delta.available, true);
  assert.equal(delta.liveBytesDelta, -400);
});


test("decodeSelftestResult maps the exported -1/0/1 scalar", () => {
  assert.deepEqual(decodeSelftestResult(1), { ran: true, pass: true });
  assert.deepEqual(decodeSelftestResult(0), { ran: true, pass: false });
  assert.deepEqual(decodeSelftestResult(-1), { ran: false, pass: null });
});

test("topHeapSamplingNodes aggregates self size by function/url across a sampling tree", () => {
  const profile = {
    head: {
      callFrame: { functionName: "(root)", url: "" },
      selfSize: 0,
      children: [
        {
          callFrame: { functionName: "churn_frame", url: "browser_perf.rs" },
          selfSize: 1000,
          children: [
            { callFrame: { functionName: "churn_frame", url: "browser_perf.rs" }, selfSize: 500, children: [] },
          ],
        },
        { callFrame: { functionName: "reuse_frame", url: "browser_perf.rs" }, selfSize: 10, children: [] },
      ],
    },
  };
  const top = topHeapSamplingNodes(profile, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, "churn_frame");
  assert.equal(top[0].selfSize, 1500);
  assert.equal(top[1].name, "reuse_frame");
});

test("topHeapSamplingNodes tolerates a missing/empty sampling profile", () => {
  assert.deepEqual(topHeapSamplingNodes(undefined, 5), []);
  assert.deepEqual(topHeapSamplingNodes({}, 5), []);
});

// --- readFramebufferPixelsStrict / bind-mode-export regressions ----------
//
// Each test below injects a specific real failure (a thrown readPixels, a
// non-NO_ERROR getError, a lost context, an all-constant readback, and a
// missing bind-mode export) that the harness's previous
// `try { gl.readPixels(...) } catch { /* left empty */ }` /
// silently-mark-configured code would NOT have caught: it would have
// returned (or compared) a pre-zeroed buffer, or silently proceeded as if
// a requested bind mode had been applied. Every test below fails against
// that old behavior and passes against the fixed `pageInstrumentation`.

test("readFramebufferPixelsStrict throws instead of silently returning a pre-zeroed buffer when gl.readPixels throws", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({ readPixels: () => { throw new Error("simulated WebGL readPixels failure"); } }),
    canvas: { width: 4, height: 4 },
  }, { freezeFrame: 5 });
  assert.throws(() => sandbox.window.__readFramebufferPixelsStrict(), /gl\.readPixels threw/);
});

test("readFramebufferPixelsStrict throws when gl.getError() reports a WebGL error after readPixels", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({
      readPixels: (x, y, w, h, format, type, out) => { out[0] = 10; out[4] = 30; },
      getError: () => 1282, // GL_INVALID_OPERATION
    }),
    canvas: { width: 2, height: 2 },
  }, { freezeFrame: 5 });
  assert.throws(() => sandbox.window.__readFramebufferPixelsStrict(), /gl\.getError\(\) reported 1282/);
});

test("readFramebufferPixelsStrict throws when the WebGL context is lost", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({ isContextLost: () => true }),
    canvas: { width: 4, height: 4 },
  }, { freezeFrame: 5 });
  assert.throws(() => sandbox.window.__readFramebufferPixelsStrict(), /context is lost/);
});

test("readFramebufferPixelsStrict throws on an all-identical readback instead of reporting false pixel parity", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({ readPixels: (x, y, w, h, format, type, out) => out.fill(0) }),
    canvas: { width: 4, height: 4 },
  }, { freezeFrame: 5 });
  assert.throws(() => sandbox.window.__readFramebufferPixelsStrict(), /fully constant readback/);
});

test("readFramebufferPixelsStrict rejects uniform RGBA pixels even when their channels differ", () => {
  for (const rgba of [[0, 0, 0, 255], [26, 26, 31, 255], [10, 20, 30, 40]]) {
    const sandbox = runPageInstrumentation({
      gl: fakeGl({
        readPixels: (x, y, w, h, format, type, out) => {
          for (let i = 0; i < out.length; i += 4) out.set(rgba, i);
        },
      }),
      canvas: { width: 4, height: 4 },
    }, { freezeFrame: 5 });
    assert.throws(() => sandbox.window.__readFramebufferPixelsStrict(), /fully constant readback/);
  }
});

test("readFramebufferPixelsStrict reads the canvas's actual dimensions, never a hardcoded/guessed size", () => {
  let capturedWidth = null, capturedHeight = null;
  const sandbox = runPageInstrumentation({
    gl: fakeGl({
      readPixels: (x, y, w, h, format, type, out) => {
        capturedWidth = w;
        capturedHeight = h;
        out[0] = 7; // one differing byte so the result is not all-identical
      },
    }),
    canvas: { width: 17, height: 9 }, // deliberately not the harness's VIEWPORT (640x400)
  }, { freezeFrame: 5 });
  const result = sandbox.window.__readFramebufferPixelsStrict();
  assert.equal(capturedWidth, 17);
  assert.equal(capturedHeight, 9);
  assert.equal(result.width, 17);
  assert.equal(result.height, 9);
});

// The following tests cover ALLOC_WINDOW_PLAN / buildAllocationWindows:
// runAllocationProfile previously measured its two steady-phase windows by
// having Node `await page.waitForFunction(() => frameIntervals.length >= n)`
// and only THEN run a separate `page.evaluate` to read counters. Because
// the page's own render loop keeps advancing frames the whole time, and
// `waitForFunction`'s 50ms polling + the evaluate round-trip both take
// real wall-clock time, Node could observe the condition only after
// several MORE frames had already run past `n` -- silently producing
// windows that were not exactly STEADY_WINDOW_FRAMES long (for example,
// 31 or 29 frames instead of exactly 30), while still reporting them as
// "equal 30-frame windows". The fix moves the snapshot into
// `pageInstrumentation`'s own `requestAnimationFrame` override, where it
// runs synchronously at the exact frame boundary, decoupled from however
// late Node gets around to reading it afterward.
function advancingRaf() {
  let now = 0;
  return (callback) => { now += 1; callback(now); return 0; };
}

test("pageInstrumentation captures allocWindowSnapshots at the exact plan frame, immune to many extra frames running before Node reads them (simulated delayed polling)", () => {
  let allocCalls = 0;
  const wasm_exports = {
    frame: () => {},
    alloc_profile_current_alloc_calls: () => { allocCalls += 1; return allocCalls; },
    alloc_profile_current_realloc_calls: () => 0,
    alloc_profile_current_dealloc_calls: () => 0,
    alloc_profile_current_live_bytes: () => 100,
    alloc_profile_current_peak_bytes: () => 100,
    alloc_profile_reset_peak: () => {},
  };
  const sandbox = runPageInstrumentation({
    gl: fakeGl(),
    canvas: { width: 4, height: 4 },
    requestAnimationFrame: advancingRaf(),
    wasm_exports,
  }, { freezeFrame: ALLOC_WINDOW_PLAN.at(-1).frame + 50, allocWindowPlan: ALLOC_WINDOW_PLAN });
  // Drive far past every plan boundary AND past freezeFrame itself, i.e.
  // simulate Node not even looking at the snapshots until long after the
  // page has kept running well beyond the intended windows.
  for (let i = 0; i < ALLOC_WINDOW_PLAN.at(-1).frame + 60; i++) {
    sandbox.window.requestAnimationFrame(() => {});
  }
  const snapshots = sandbox.window.__perf.allocWindowSnapshots;
  for (const entry of ALLOC_WINDOW_PLAN) {
    assert.equal(snapshots[entry.name].frame, entry.frame, `${entry.name} must be captured at exactly frame ${entry.frame}`);
  }
  const { windowA, windowB } = buildAllocationWindows(snapshots);
  assert.equal(windowA.endFrame - windowA.startFrame, 30);
  assert.equal(windowB.endFrame - windowB.startFrame, 30);
  assert.equal(windowA.endFrame, windowB.startFrame);
});

test("pageInstrumentation's requestAnimationFrame override requires the alloc-window-plan exports instead of silently skipping a boundary", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl(),
    canvas: { width: 4, height: 4 },
    requestAnimationFrame: advancingRaf(),
    wasm_exports: { frame: () => {} }, // deliberately missing every alloc_profile_current_* export
  }, { freezeFrame: 1000, allocWindowPlan: [{ frame: 0, name: "windowAStart", resetPeak: true }] });
  assert.throws(() => sandbox.window.requestAnimationFrame(() => {}), /allocWindowPlan entry 'windowAStart'/);
  assert.match(sandbox.window.__perf.fatalError, /allocWindowPlan entry 'windowAStart'/);
});

test("buildAllocationWindows throws instead of accepting an off-by-one window (regression for the former waitForFunction(>=n) overshoot race)", () => {
  const counters = { allocCalls: 1, reallocCalls: 0, deallocCalls: 1, liveBytes: 0, peakBytes: 0 };
  const okSnapshots = {
    windowAStart: { frame: 60, counters },
    windowAEnd: { frame: 90, counters },
    windowBStart: { frame: 90, counters },
    windowBEnd: { frame: 120, counters },
  };
  assert.doesNotThrow(() => buildAllocationWindows(okSnapshots));

  // Simulates exactly the described old-code failure mode: Node's late
  // poll observed `frameIntervals.length >= 90` only after the page had
  // already reached frame 91 (one extra frame slipped through), so
  // windowA would have silently been 31 frames instead of 30.
  const overshotSnapshots = { ...okSnapshots, windowAEnd: { frame: 91, counters } };
  assert.throws(() => buildAllocationWindows(overshotSnapshots), /windowAEnd' was captured at frame 91, expected exactly 90/);

  const missingSnapshots = { ...okSnapshots, windowBStart: undefined };
  assert.throws(() => buildAllocationWindows(missingSnapshots), /missing snapshot 'windowBStart'/);
});

test("pageInstrumentation's requestAnimationFrame override requires the bind-mode export instead of silently marking it configured", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl(),
    canvas: { width: 4, height: 4 },
    wasm_exports: {}, // deliberately missing alloc_profile_set_bind_mode
  }, { freezeFrame: 5, initialBindMode: 1 });
  assert.throws(() => sandbox.window.requestAnimationFrame(() => {}), /alloc_profile_set_bind_mode is missing/);
  // The old behavior marked bindModeConfiguredAtFrame non-null even when
  // the export was missing and the mode was therefore never applied.
  assert.equal(sandbox.window.__perf.bindModeConfiguredAtFrame, null);
  assert.match(sandbox.window.__perf.fatalError, /alloc_profile_set_bind_mode is missing/);
});

test("pageInstrumentation applies the requested bind mode and marks it configured when the export exists", () => {
  let appliedMode = null;
  const sandbox = runPageInstrumentation({
    gl: fakeGl(),
    canvas: { width: 4, height: 4 },
    wasm_exports: { alloc_profile_set_bind_mode: (mode) => { appliedMode = mode; } },
  }, { freezeFrame: 5, initialBindMode: 1 });
  sandbox.window.requestAnimationFrame(() => {});
  assert.equal(appliedMode, 1);
  assert.equal(sandbox.window.__perf.bindModeConfiguredAtFrame, 0);
  assert.equal(sandbox.window.__perf.fatalError, null);
});

// The two tests below cover the freeze-time synchronous pixel-capture fix:
// earlier code read pixels later, via a separate `page.evaluate`, after the
// un-`preserveDrawingBuffer`-protected WebGL drawing buffer could already
// have been invalidated by the browser (observed in practice as an
// all-zero readback with no GL error at all -- a defect `getError`/
// context-loss checks alone cannot catch, since nothing actually errors).
// `freezeFrame: 0` makes the override's freeze branch fire on its very
// first invocation, before any frame is scheduled, so these tests exercise
// that branch directly without needing a real animation loop.

test("pageInstrumentation captures real framebuffer pixels synchronously in its own freeze branch, not via a later read", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({
      readPixels: (x, y, w, h, format, type, out) => { out[0] = 42; }, // one differing byte: not all-identical
    }),
    canvas: { width: 3, height: 2 },
  }, { freezeFrame: 0 });
  const result = sandbox.window.requestAnimationFrame(() => {});
  assert.equal(result, 0); // deterministic freeze return value
  assert.equal(sandbox.window.__perf.frozenAtFrame, 0);
  assert.equal(sandbox.window.__perf.fatalError, null);
  // `readFramebufferPixelsStrict` returns `pixels` as a plain `Array`
  // (`Array.from(...)`), not a typed array, so it serializes cleanly
  // across a `page.evaluate` round-trip elsewhere in this file.
  assert.ok(Array.isArray(sandbox.window.__perf.frozenFramePixels));
  assert.equal(sandbox.window.__perf.frozenFramePixels.length, 3 * 2 * 4);
  assert.equal(sandbox.window.__perf.frozenFramePixels[0], 42);
  assert.equal(sandbox.window.__perf.frozenFrameSize.width, 3);
  assert.equal(sandbox.window.__perf.frozenFrameSize.height, 2);
});

test("pageInstrumentation records a fatalError (without hanging the freeze wait) when freeze-time pixel capture fails", () => {
  const sandbox = runPageInstrumentation({
    gl: fakeGl({ readPixels: () => { throw new Error("simulated WebGL readPixels failure"); } }),
    canvas: { width: 3, height: 2 },
  }, { freezeFrame: 0 });
  sandbox.window.requestAnimationFrame(() => {});
  // `frozenAtFrame` must still be set even on capture failure, so that
  // `waitForFreezeOrFatalError`'s `page.waitForFunction` (which waits for
  // `frozenAtFrame !== null || fatalError`) cannot hang; the subsequent
  // explicit `fatalError` check is what actually surfaces the failure.
  assert.equal(sandbox.window.__perf.frozenAtFrame, 0);
  assert.match(sandbox.window.__perf.fatalError, /freeze-time pixel capture failed.*gl\.readPixels threw/s);
  assert.equal(sandbox.window.__perf.frozenFramePixels, null);
  assert.equal(sandbox.window.__perf.frozenFrameSize, null);
});
