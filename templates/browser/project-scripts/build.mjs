#!/usr/bin/env node
// Builds the WASM application and copies it into the web output
// directory. Uses only Node.js builtins; no npm dependencies.
//
// Usage: node scripts/build.mjs [--release|--debug]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
}

main();
