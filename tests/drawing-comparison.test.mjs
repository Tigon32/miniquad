import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { median, classifyRuntime, measureArtifact, wasmPath, checkAreaTolerances, AREA_TOLERANCE } from "../scripts/compare-drawing.mjs";
function shapeReport(areas) {
  return { shapes: Object.entries(areas).map(([shape, total_area]) => ({ shape, total_area })) };
}


test("median returns the middle value for an odd-length array", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median averages the two middle values for an even-length array", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("median does not mutate its input array", () => {
  const values = [5, 1, 3];
  median(values);
  assert.deepEqual(values, [5, 1, 3]);
});

test("median rejects an empty array instead of returning a misleading value", () => {
  assert.throws(() => median([]), /empty array/);
});

test("classifyRuntime is inconclusive when the sample ranges overlap", () => {
  // A min of 5 for B falls inside A's [1, 10] range.
  assert.equal(classifyRuntime([1, 10], [5, 20]), "inconclusive");
});

test("classifyRuntime is distinguishable when the sample ranges are disjoint", () => {
  assert.equal(classifyRuntime([1, 2, 3], [10, 11, 12]), "distinguishable");
});

test("classifyRuntime treats touching ranges as overlapping (conservative)", () => {
  assert.equal(classifyRuntime([1, 5], [5, 9]), "inconclusive");
});

test("wasmPath builds a backend-specific target-dir path", () => {
  const internal = wasmPath("internal");
  const lyon = wasmPath("lyon");
  assert.match(internal, /target-internal.*drawing_comparison\.wasm$/);
  assert.match(lyon, /target-lyon.*drawing_comparison\.wasm$/);
  assert.notEqual(internal, lyon);
});

test("measureArtifact reads exact files without requiring prebuilt benchmark artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "miniquad-drawing-artifact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "empty.wasm");
  writeFileSync(path, Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const artifact = measureArtifact("internal", path);
  assert.equal(artifact.backend, "internal");
  assert.ok(artifact.rawBytes > 0, "raw size must be a real, non-zero byte count");
  assert.ok(artifact.gzipBytes > 0, "compression can increase the size of a small artifact");
  assert.ok(artifact.brotliBytes > 0, "brotli size must be a real, non-zero byte count");
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/, "sha256 must be a real 64-character hex digest");
});

test("measureArtifact reports a missing input instead of measuring a fallback", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "miniquad-drawing-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => measureArtifact("lyon", join(dir, "missing.wasm")), /missing lyon WASM artifact/);
});

test("checkAreaTolerances requires exact rect/triangle area equality", () => {
  const internal = shapeReport({ rects: 14000, triangles: 8100, circles: 24971.57, curve_strokes: 1915.43 });
  const lyon = shapeReport({ rects: 14000.0001, triangles: 8100, circles: 24491.76, curve_strokes: 1917.3 });
  const result = checkAreaTolerances(internal, lyon);
  assert.equal(result.rects.withinTolerance, false, "any rect area mismatch must fail (tolerance is 0)");
  assert.equal(result.triangles.withinTolerance, true);
});

test("checkAreaTolerances accepts the documented real circle/curve differences", () => {
  const internal = shapeReport({ rects: 14000, triangles: 8100, circles: 24971.572469653038, curve_strokes: 1915.4326597578356 });
  const lyon = shapeReport({ rects: 14000, triangles: 8100, circles: 24491.760360374697, curve_strokes: 1917.3037460932273 });
  const result = checkAreaTolerances(internal, lyon);
  for (const shape of Object.keys(AREA_TOLERANCE)) {
    assert.equal(result[shape].withinTolerance, true, `${shape} should be within its documented tolerance`);
  }
});

test("checkAreaTolerances flags a circle-area regression beyond the documented 3% bound", () => {
  const internal = shapeReport({ rects: 14000, triangles: 8100, circles: 24971.57, curve_strokes: 1915.43 });
  const lyon = shapeReport({ rects: 14000, triangles: 8100, circles: 20000, curve_strokes: 1917.3 });
  const result = checkAreaTolerances(internal, lyon);
  assert.equal(result.circles.withinTolerance, false);
});
