// Tests for scripts/compare-voxel.mjs: the issue #29 pinned
// block-mesh comparison orchestrator. The pure parser is tested with
// a fixture string (no process dependency); the real
// `runComparison()` path is exercised only when a cargo toolchain is
// actually available, and is skipped (not faked) otherwise - this
// repository's local checks run with PATH prepended with
// ~/.cargo/bin, but a CI runner may not have it, so the test must not
// assume a specific PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { parseCompareOutput, runComparison, crateDir } from "../scripts/compare-voxel.mjs";

const FIXTURE_STDOUT = `voxel-comparison: pinned block-mesh = 0.2.0 (MIT OR Apache-2.0)
workload: one SCENE_CHUNK_DIMS chunk (8x12x8 = 768 voxels), SCENE_SEED terrain, origin (0,0), no neighbor chunk

miniquad-voxel build_chunk_mesh:
  repetitions: 400
  time (us): mean=27.55 min=27.17 max=38.33 stddev=0.78
  quads: 742
  mesh bytes (vertices+indices heap payload): 136528
  mesh hash (FNV-1a over positions/normals/colors): 0x2bb79974af341743

block-mesh visible_block_faces:
  repetitions: 200
  time (us): mean=1.42 min=1.38 max=7.92 stddev=0.47
  quads: 742

correctness: quad counts match (742 == 742).
`;

const MISMATCH_STDOUT = FIXTURE_STDOUT.replace(
  "correctness: quad counts match (742 == 742).",
  "correctness: MISMATCH (742 != 741) - do not report a performance claim until this is resolved.",
).replace("  quads: 742\n\ncorrectness", "  quads: 741\n\ncorrectness");

test("parseCompareOutput reads the pinned version and license", () => {
  const result = parseCompareOutput(FIXTURE_STDOUT);
  assert.equal(result.pinnedVersion, "0.2.0");
  assert.equal(result.pinnedLicense, "MIT OR Apache-2.0");
});

test("parseCompareOutput reads both meshers' timing and quad counts", () => {
  const result = parseCompareOutput(FIXTURE_STDOUT);
  assert.deepEqual(result.miniquadVoxel, {
    repetitions: 400,
    meanUs: 27.55,
    minUs: 27.17,
    maxUs: 38.33,
    stddevUs: 0.78,
    quads: 742,
  });
  assert.deepEqual(result.blockMesh, {
    repetitions: 200,
    meanUs: 1.42,
    minUs: 1.38,
    maxUs: 7.92,
    stddevUs: 0.47,
    quads: 742,
  });
  assert.equal(result.correct, true);
});

test("parseCompareOutput reports correct: false on a reported mismatch, without guessing", () => {
  const result = parseCompareOutput(MISMATCH_STDOUT);
  assert.equal(result.correct, false);
});

test("parseCompareOutput returns null fields for unparseable input rather than throwing", () => {
  const result = parseCompareOutput("not the expected format at all");
  assert.equal(result.pinnedVersion, null);
  assert.equal(result.miniquadVoxel, null);
  assert.equal(result.blockMesh, null);
  assert.equal(result.correct, null);
});

function findCargoBinDir() {
  try {
    const cargoPath = execSync("command -v cargo", { encoding: "utf8" }).trim();
    if (cargoPath) return null; // already on PATH
  } catch {
    // fall through to the common rustup install location
  }
  const home = process.env.HOME;
  if (home) {
    const candidate = `${home}/.cargo/bin`;
    try {
      execSync(`test -x ${candidate}/cargo`);
      return candidate;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const cargoBinDir = findCargoBinDir();

test(
  "runComparison runs the real isolated benchmark crate and reports a correctness match",
  { skip: cargoBinDir === undefined ? "cargo toolchain not found on this host" : false },
  () => {
    const outcome = runComparison({ cwd: crateDir, extraPath: cargoBinDir ?? undefined });
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(outcome.result.correct, true);
    assert.ok(outcome.result.miniquadVoxel.quads > 0);
    assert.equal(outcome.result.miniquadVoxel.quads, outcome.result.blockMesh.quads);
  },
);
