#!/usr/bin/env node
// Issue #123: pair the internal miniquad-draw CPU geometry backend
// against the pinned Lyon benchmark-only adapter on the same bounded
// reference workload (experiments/drawing-comparison). Compares real
// compiled WASM artifacts: raw/gzip/brotli size, SHA-256, and paired
// alternating wall-clock runtime inside a real WASM runtime (Node's
// `WebAssembly`). Never infers or reports a speed or size win without
// measured bytes.
//
// Usage:
//   node scripts/compare-drawing.mjs [repeats]
//
// Expects both backends already built (see docs/drawing-companion.md):
//   cargo build --release --target wasm32-unknown-unknown \
//     --no-default-features --features internal --lib \
//     --manifest-path experiments/drawing-comparison/Cargo.toml \
//     --target-dir experiments/drawing-comparison/target-internal
//   cargo build --release --target wasm32-unknown-unknown \
//     --no-default-features --features lyon --lib \
//     --manifest-path experiments/drawing-comparison/Cargo.toml \
//     --target-dir experiments/drawing-comparison/target-lyon
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function wasmPath(backend) {
  return resolve(
    root,
    `experiments/drawing-comparison/target-${backend}/wasm32-unknown-unknown/release/drawing_comparison.wasm`,
  );
}

export function measureArtifact(backend, path) {
  const bytes = readFileSync(path);
  return {
    backend,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

/** Median of a non-empty array of numbers. Exported for direct testing. */
export function median(values) {
  if (values.length === 0) {
    throw new Error("median of an empty array is undefined");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * A paired runtime comparison is INCONCLUSIVE when the two backends'
 * measurement spreads (max-min across repeats) overlap: the Performance
 * proof skill requires reporting "inconclusive" whenever "measurement
 * noise is as large as the change". This treats any overlap between
 * [min,max] of each side as noise at least as large as the observed
 * median difference, a conservative (not optimistic) rule on a shared,
 * possibly noisy host.
 */
export function classifyRuntime(samplesA, samplesB) {
  const minA = Math.min(...samplesA);
  const maxA = Math.max(...samplesA);
  const minB = Math.min(...samplesB);
  const maxB = Math.max(...samplesB);
  const overlaps = minA <= maxB && minB <= maxA;
  return overlaps ? "inconclusive" : "distinguishable";
}

async function loadModule(path) {
  const bytes = readFileSync(path);
  const mod = await WebAssembly.compile(bytes);
  // The `internal` build links the whole `miniquad` crate through the
  // `miniquad-draw` path dependency, so the wasm32 target emits its
  // usual windowing-bridge imports (`sapp_set_cursor`, `fs_get_buffer_size`,
  // ...) even though this benchmark never opens a window or calls them.
  // Stub every declared "env" import with a no-op so the module
  // instantiates without a real `js/gl.js` host; this benchmark only
  // calls the exported `run()` (pure CPU geometry), never anything that
  // would actually invoke a windowing import.
  const imports = { env: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === "function") {
      imports[imp.module] ??= {};
      imports[imp.module][imp.name] = () => {};
    }
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  return instance.exports.run;
}

async function timeRuns(run, repeats) {
  const timingsMs = [];
  let lastChecksum = null;
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    lastChecksum = run();
    timingsMs.push(performance.now() - start);
  }
  return { timingsMs, lastChecksum };
}

async function main() {
  const repeats = Number(process.argv[2] ?? 5);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error("repeats must be a positive integer");
  }

  const internalPath = wasmPath("internal");
  const lyonPath = wasmPath("lyon");
  const internalArtifact = measureArtifact("internal", internalPath);
  const lyonArtifact = measureArtifact("lyon", lyonPath);

  const runInternal = await loadModule(internalPath);
  const runLyon = await loadModule(lyonPath);

  // Alternate backends on every repeat (not all-internal-then-all-lyon)
  // so host noise (thermal, scheduler, other processes) is distributed
  // across both sides equally, per the Performance proof skill's
  // "alternate the old and new versions when possible".
  const internalTimingsMs = [];
  const lyonTimingsMs = [];
  let internalChecksum = null;
  let lyonChecksum = null;
  for (let i = 0; i < repeats; i += 1) {
    const a = await timeRuns(runInternal, 1);
    internalTimingsMs.push(a.timingsMs[0]);
    internalChecksum = a.lastChecksum;
    const b = await timeRuns(runLyon, 1);
    lyonTimingsMs.push(b.timingsMs[0]);
    lyonChecksum = b.lastChecksum;
  }

  const report = {
    sourceHead: process.env.GITHUB_HEAD_SHA || process.env.GITHUB_SHA || "local",
    issue: 123,
    workload:
      "experiments/drawing-comparison/src/workload.rs: 50 rectangles, 50 triangles, " +
      "20 circles (radius 20), 10 stroked cubic curves (tolerance 0.5, thickness 2.0)",
    repeats,
    runtime: "Node WebAssembly (not a browser; see tests/browser/drawing.spec.mjs for browser pixel checks)",
    nodeVersion: process.version,
    artifacts: { internal: internalArtifact, lyon: lyonArtifact },
    sizeDelta: {
      rawBytes: lyonArtifact.rawBytes - internalArtifact.rawBytes,
      gzipBytes: lyonArtifact.gzipBytes - internalArtifact.gzipBytes,
      brotliBytes: lyonArtifact.brotliBytes - internalArtifact.brotliBytes,
    },
    runtimeMs: {
      internal: { samples: internalTimingsMs, median: median(internalTimingsMs) },
      lyon: { samples: lyonTimingsMs, median: median(lyonTimingsMs) },
      classification: classifyRuntime(internalTimingsMs, lyonTimingsMs),
    },
    checksums: {
      // The exported `run()` returns the workload's total vertex count:
      // a non-zero, backend-specific value confirms the real geometry
      // code ran (see src/lib.rs), not a stub that always returns 0.
      internal: internalChecksum,
      lyon: lyonChecksum,
    },
    limitations: [
      "Compares CPU-side geometry/tessellation cost and WASM artifact size, not a GPU frame time: neither backend uploads to a GPU in this comparison (see docs/drawing-companion.md).",
      "Runtime is measured in Node's WebAssembly runtime, not a browser WASM runtime; it is not a browser frame-time measurement.",
      "Not pixel-exact: Lyon's circle and stroke tessellation differ from the internal fixed-segment/butt-cap implementation (see docs/drawing-companion.md for the per-shape area/bounding-box tolerances accepted here).",
      "A shared, possibly noisy macOS host ran all repeats; report 'inconclusive' values are not evidence of equal or unequal performance.",
    ],
  };

  const file = resolve(root, "test-results/drawing-comparison.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log("Drawing comparison (issue #123)", JSON.stringify(report));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
