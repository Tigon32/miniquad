#!/usr/bin/env node
// Builds the WASM application and copies it into the web output
// directory. Uses only Node.js builtins; no npm dependencies.
//
// Usage: node scripts/build.mjs [--release|--debug]

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "{{PACKAGE_NAME}}";
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM_TARGET = "wasm32-unknown-unknown";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  return result;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Records app.wasm and index.html, the two files produced or finalized
// by this build step (not copied verbatim from the selected Miniquad
// source), in the same web/MANIFEST.json the generator already wrote.
// This keeps the shipped source provenance (mode/sha/dirty, recorded at
// generation time) bound to the hashes of what actually ships, without
// overwriting the five source-copied asset entries already present.
export function updateManifestWithBuildOutputs(webDir, entries) {
  const manifestPath = join(webDir, "MANIFEST.json");
  if (!existsSync(manifestPath)) {
    fail(
      `Missing web/MANIFEST.json at: ${manifestPath}\n` +
        "This file is written by create-browser-project.mjs. Re-run the " +
        "generator; do not build a web/ directory it did not create."
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Could not parse web/MANIFEST.json: ${error.message}`);
  }
  if (!Array.isArray(manifest.files)) {
    manifest.files = [];
  }
  for (const entry of entries) {
    const existingIndex = manifest.files.findIndex((candidate) => candidate.file === entry.file);
    if (existingIndex === -1) {
      manifest.files.push(entry);
    } else {
      manifest.files[existingIndex] = entry;
    }
  }
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function checkToolchain() {
  const cargoCheck = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (cargoCheck.error || cargoCheck.status !== 0) {
    fail(
      "cargo was not found on PATH. Install Rust from https://rustup.rs " +
        "and ensure the cargo command is available."
    );
  }

  const targetCheck = spawnSync(
    "rustup",
    ["target", "list", "--installed"],
    { encoding: "utf8" }
  );
  if (!targetCheck.error && targetCheck.status === 0) {
    const installed = targetCheck.stdout || "";
    if (!installed.split(/\s+/).includes(WASM_TARGET)) {
      fail(
        `Rust target "${WASM_TARGET}" is not installed. Run: ` +
          `rustup target add ${WASM_TARGET}`
      );
    }
  }
  // When rustup itself is unavailable, fall through and let cargo
  // report a missing-target error directly; that error already names
  // the target and is actionable.
}

function main() {
  const profile = process.argv.includes("--debug") ? "debug" : "release";
  checkToolchain();

  const cargoArgs = ["build", "--target", WASM_TARGET];
  if (profile === "release") {
    cargoArgs.push("--release");
  }

  const build = run("cargo", cargoArgs);
  if (build.error || build.status !== 0) {
    fail("cargo build failed. See the compiler output above.");
  }

  const builtWasm = join(
    PROJECT_ROOT,
    "target",
    WASM_TARGET,
    profile,
    `${PACKAGE_NAME}.wasm`
  );
  if (!existsSync(builtWasm)) {
    fail(
      `Expected build output was not found: ${builtWasm}\n` +
        "Confirm the package name in Cargo.toml matches the [[bin]] entry."
    );
  }

  const webDir = join(PROJECT_ROOT, "web");
  mkdirSync(webDir, { recursive: true });
  const destWasm = join(webDir, "app.wasm");
  copyFileSync(builtWasm, destWasm);
  console.log(`Built and copied: ${destWasm}`);

  const indexHtmlPath = join(webDir, "index.html");
  if (!existsSync(indexHtmlPath)) {
    fail(
      `Expected web/index.html was not found: ${indexHtmlPath}\n` +
        "This file is written by create-browser-project.mjs. Re-run the " +
        "generator; do not build a web/ directory it did not create."
    );
  }
  const wasmBytes = readFileSync(destWasm);
  const indexHtmlBytes = readFileSync(indexHtmlPath);
  updateManifestWithBuildOutputs(webDir, [
    { file: "app.wasm", sha256: sha256(wasmBytes), bytes: wasmBytes.length },
    { file: "index.html", sha256: sha256(indexHtmlBytes), bytes: indexHtmlBytes.length },
  ]);
  console.log(`Updated manifest: ${join(webDir, "MANIFEST.json")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
