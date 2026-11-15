import assert from "node:assert/strict";
import test from "node:test";
import { buildFixture } from "./generate-fixture.mjs";

test("public fixture has the fixed scene counts and bounded cell levels", () => {
  const fixture = buildFixture();

  assert.deepEqual(fixture.counts, {
    occupiedCells: 152,
    voxelLevels: 686,
    pathPoints: 180,
    arrows: 20,
    vectorItems: 200,
  });
  assert.equal(fixture.cells.length, fixture.counts.occupiedCells);
  assert.ok(fixture.cells.every((cell) => cell.height >= 1 && cell.height <= fixture.levelLimit));
  assert.equal(fixture.cells.reduce((sum, cell) => sum + cell.height, 0), fixture.counts.voxelLevels);
  assert.equal(fixture.schema.coordinateOrder, "q, r, then z");
  assert.match(fixture.schema.levelMeaning, /unit voxels along \+z/);
  assert.match(fixture.schema.numericEncoding, /binary32/);
  assert.match(fixture.schema.units, /grid units/);
});

test("fixture geometry and layer ranges are complete and deterministic", () => {
  const fixture = buildFixture();
  const vertexCount = fixture.vertices.length / 6;

  assert.ok(Number.isInteger(vertexCount));
  assert.ok(fixture.indices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount));
  assert.deepEqual(fixture, buildFixture());
  const orderedLayers = Object.values(fixture.layers);
  let nextIndex = 0;
  for (const layer of orderedLayers) {
    assert.equal(layer.firstIndex, nextIndex);
    assert.ok(layer.indexCount > 0);
    nextIndex += layer.indexCount;
  }
  assert.equal(nextIndex, fixture.indices.length);
  assert.deepEqual(fixture.visualChecks.map((check) => check.layer), [
    "grid",
    "voxels",
    "path",
    "arrow",
    "background",
  ]);
  assert.ok(fixture.visualChecks.every(({ sample: [x, y] }) =>
    x >= 0 && x < fixture.width && y >= 0 && y < fixture.height
  ));
  assert.deepEqual(fixture.absentChecks.map((check) => check.layer), ["samplePoints"]);
  assert.ok(fixture.absentChecks.every(({ sample: [x, y] }) =>
    x >= 0 && x < fixture.width && y >= 0 && y < fixture.height
  ));
});
