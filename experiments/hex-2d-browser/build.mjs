#!/usr/bin/env node
// Builds both WebGL1 (default) and WebGL2 (`HEX_BOARD_WEBGL=2`) release
// WASM binaries of `companions/draw/examples/hex_board.rs`, and copies
// them to `experiments/hex-2d-browser/build/` for `serve.mjs`
// (`docs/hex-2d-contract.md` section 3.8). This directory is
// git-ignored: run this script before the browser tests.
//
// Usage: node experiments/hex-2d-browser/build.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outDir = resolve(here, "build");
mkdirSync(outDir, { recursive: true });

const manifestPath = resolve(repoRoot, "companions/draw/Cargo.toml");
const wasmOut = resolve(
  repoRoot,
  "companions/draw/target/wasm32-unknown-unknown/release/examples/hex_board.wasm"
);

function build(label, env, destName) {
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      manifestPath,
      "--example",
      "hex_board"
    ],
    { stdio: "inherit", env: { ...process.env, ...env } }
  );
  if (result.status !== 0) {
    console.error(label + " build failed");
    process.exit(result.status ?? 1);
  }
  copyFileSync(wasmOut, resolve(outDir, destName));
  console.log(label + " -> " + resolve(outDir, destName));
}

build("WebGL1", { HEX_BOARD_WEBGL: "1" }, "hex_board_webgl1.wasm");
build("WebGL2", { HEX_BOARD_WEBGL: "2" }, "hex_board_webgl2.wasm");
