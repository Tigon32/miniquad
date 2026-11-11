import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { median, classifyRuntime, measureArtifact, wasmPath } from "../scripts/compare-drawing.mjs";

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

test("measureArtifact reports real, non-zero size and hash fields when the WASM artifact is built", { skip: !existsSync(wasmPath("internal")) && "internal benchmark WASM artifact not built; run the cargo build command in docs/drawing-companion.md first" }, () => {
  const artifact = measureArtifact("internal", wasmPath("internal"));
  assert.equal(artifact.backend, "internal");
  assert.ok(artifact.rawBytes > 0, "raw size must be a real, non-zero byte count");
  assert.ok(artifact.gzipBytes > 0 && artifact.gzipBytes <= artifact.rawBytes, "gzip size must be real and no larger than raw");
  assert.ok(artifact.brotliBytes > 0, "brotli size must be a real, non-zero byte count");
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/, "sha256 must be a real 64-character hex digest");
});

test("measureArtifact produces different hashes for the internal and lyon artifacts when both are built", { skip: (!existsSync(wasmPath("internal")) || !existsSync(wasmPath("lyon"))) && "both benchmark WASM artifacts must be built; see docs/drawing-companion.md" }, () => {
  const internal = measureArtifact("internal", wasmPath("internal"));
  const lyon = measureArtifact("lyon", wasmPath("lyon"));
  assert.notEqual(internal.sha256, lyon.sha256);
});
