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
// Builds both backends from a clean tracked tree before measurement:
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
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function wasmPath(backend) {
  return resolve(
    root,
    `experiments/drawing-comparison/target-${backend}/wasm32-unknown-unknown/release/drawing_comparison.wasm`,
  );
}

export function measureArtifact(backend, path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(
      `missing ${backend} WASM artifact at ${path}; build it first (see docs/drawing-companion.md)`,
      { cause: err },
    );
  }
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

/**
 * Per-shape area tolerance, as a fraction of the internal backend's
 * area (not an antialias/edge allowance: this bounds real tessellation
 * differences documented in docs/drawing-companion.md). Rects and
 * filled triangles have no curved edges, so both backends must agree
 * exactly.
 */
export const AREA_TOLERANCE = {
  rects: 0,
  triangles: 0,
  circles: 0.03,
  curve_strokes: 0.01,
};

/** Run a backend's native driver binary and parse its one-line JSON report. */
export function runNative(backend, repeats) {
  const bin = backend === "internal" ? "run_internal" : "run_lyon";
  const stdout = execFileSync(
    "cargo",
    [
      "run",
      "--release",
      "--locked",
      "--quiet",
      "--no-default-features",
      "--features",
      backend,
      "--manifest-path",
      resolve(root, "experiments/drawing-comparison/Cargo.toml"),
      "--bin",
      bin,
      "--",
      String(repeats),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
}

/**
 * Compares the two backends' per-shape total_area against
 * `AREA_TOLERANCE`. Returns one entry per shape kind with the actual
 * relative difference and whether it is within the recorded tolerance,
 * so a receipt cannot claim a tolerance was respected without this
 * function having checked the real numbers.
 */
export function checkAreaTolerances(internalReport, lyonReport) {
  const results = {};
  for (const shape of Object.keys(AREA_TOLERANCE)) {
    const a = internalReport.shapes.find((s) => s.shape === shape).total_area;
    const b = lyonReport.shapes.find((s) => s.shape === shape).total_area;
    const relativeDiff = a === 0 ? (b === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(a);
    const tolerance = AREA_TOLERANCE[shape];
    results[shape] = {
      internalArea: a,
      lyonArea: b,
      relativeDiff,
      tolerance,
      withinTolerance: relativeDiff <= tolerance,
    };
  }
  return results;
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
  // The pure CPU workload must not call any browser import.
  const imports = { env: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === "function") {
      imports[imp.module] ??= {};
      imports[imp.module][imp.name] = () => {
        throw new Error(`Unexpected benchmark import: ${imp.module}.${imp.name}`);
      };
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
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Commit tracked changes before recording a drawing comparison");
  }
  const sourceHead = git("rev-parse", "HEAD");
  for (const backend of ["internal", "lyon"]) {
    execFileSync("cargo", [
      "build", "--release", "--locked", "--target", "wasm32-unknown-unknown",
      "--no-default-features", "--features", backend, "--lib",
      "--manifest-path", resolve(root, "experiments/drawing-comparison/Cargo.toml"),
      "--target-dir", resolve(root, `experiments/drawing-comparison/target-${backend}`),
    ], { stdio: "inherit" });
  }

  const internalPath = wasmPath("internal");
  const lyonPath = wasmPath("lyon");
  const internalArtifact = measureArtifact("internal", internalPath);
  const lyonArtifact = measureArtifact("lyon", lyonPath);

  const internalNative = runNative("internal", repeats);
  const lyonNative = runNative("lyon", repeats);
  const areaTolerances = checkAreaTolerances(internalNative, lyonNative);
  const areaViolations = Object.entries(areaTolerances).filter(([, v]) => !v.withinTolerance);

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
  if (internalChecksum !== internalNative.total_vertices || lyonChecksum !== lyonNative.total_vertices) {
    throw new Error("WASM and native workload vertex counts differ");
  }

  const report = {
    sourceHead,
    rustVersion: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    cargoVersion: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
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
    areaTolerances,
    areaTolerancesRespected: areaViolations.length === 0,
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

  if (areaViolations.length > 0) {
    throw new Error(
      `area tolerance exceeded for: ${areaViolations.map(([k, v]) => `${k} (${(v.relativeDiff * 100).toFixed(2)}% > ${(v.tolerance * 100).toFixed(2)}%)`).join(", ")}`,
    );
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
