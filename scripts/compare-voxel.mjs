#!/usr/bin/env node
// Orchestrates the issue #29 pinned block-mesh comparison benchmark in
// experiments/voxel-comparison/. Never fabricates a result: if cargo or
// the crate is unavailable, this reports `ok: false` with a reason
// instead of inventing numbers. Pure parsing logic
// (parseCompareOutput) has no process dependency and is covered
// directly by tests/voxel-comparison.test.mjs.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const crateDir = resolve(repoRoot, "experiments/voxel-comparison");

/**
 * Parses `compare`'s stdout (see
 * experiments/voxel-comparison/src/bin/compare.rs) into a structured
 * result. Returns `null` for any field it cannot find, rather than
 * guessing, so a caller can tell a genuinely missing/changed-format
 * line apart from a real zero.
 */
export function parseCompareOutput(stdout) {
  const pin = /pinned block-mesh = ([^\s(]+) \(([^)]+)\)/.exec(stdout);
  const miniquadBlock = /miniquad-voxel build_chunk_mesh:\n([\s\S]*?)\n\nblock-mesh/.exec(stdout);
  const blockMeshBlock = /block-mesh visible_block_faces:\n([\s\S]*?)\n\ncorrectness/.exec(stdout);

  const parseSide = (block) => {
    if (!block) return null;
    const repetitions = /repetitions: (\d+)/.exec(block);
    const timing = /time \(us\): mean=([\d.]+) min=([\d.]+) max=([\d.]+) stddev=([\d.]+)/.exec(
      block,
    );
    const quads = /quads: (\d+)/.exec(block);
    if (!repetitions || !timing || !quads) return null;
    return {
      repetitions: Number(repetitions[1]),
      meanUs: Number(timing[1]),
      minUs: Number(timing[2]),
      maxUs: Number(timing[3]),
      stddevUs: Number(timing[4]),
      quads: Number(quads[1]),
    };
  };

  const correctnessMatch = /correctness: quad counts match \((\d+) == (\d+)\)\./.exec(stdout);
  const mismatchMatch = /correctness: MISMATCH \((\d+) != (\d+)\)/.exec(stdout);

  return {
    pinnedVersion: pin ? pin[1] : null,
    pinnedLicense: pin ? pin[2] : null,
    miniquadVoxel: parseSide(miniquadBlock ? miniquadBlock[1] : null),
    blockMesh: parseSide(blockMeshBlock ? blockMeshBlock[1] : null),
    correct: correctnessMatch ? true : mismatchMatch ? false : null,
  };
}

/**
 * Runs `cargo run --release --bin compare` in the isolated benchmark
 * crate and returns `{ ok: true, result }` on success or
 * `{ ok: false, reason }` on any failure (missing cargo, build
 * failure, unparseable output, or a reported correctness mismatch).
 * Never throws for an expected failure mode; a caller decides whether
 * a `{ ok: false }` result should fail a test or just be recorded as
 * BLOCKED/NOT RUN evidence.
 */
export function runComparison({ cargoPath = "cargo", cwd = crateDir, extraPath } = {}) {
  const env = { ...process.env };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH ?? ""}`;

  const proc = spawnSync(cargoPath, ["run", "--release", "--bin", "compare"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });

  if (proc.error) {
    return { ok: false, reason: `cargo not runnable: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      reason: `cargo exited with status ${proc.status}`,
      stdout: proc.stdout,
      stderr: proc.stderr,
    };
  }

  const result = parseCompareOutput(proc.stdout);
  if (!result.miniquadVoxel || !result.blockMesh) {
    return { ok: false, reason: "could not parse compare binary output", stdout: proc.stdout };
  }
  if (result.correct !== true) {
    return {
      ok: false,
      reason: "compare binary reported a quad-count mismatch (correctness failed)",
      result,
    };
  }
  return { ok: true, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = runComparison({ extraPath: process.env.CARGO_BIN_PATH });
  if (!outcome.ok) {
    console.error(`voxel-comparison: BLOCKED - ${outcome.reason}`);
    if (outcome.stderr) console.error(outcome.stderr);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(outcome.result, null, 2));
  }
}
