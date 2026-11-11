import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  validateSamples,
  aggregate,
  pairDelta,
  summarizePairs,
  compressionReport,
  pixelParity,
} from "../scripts/profile-browser.mjs";

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
