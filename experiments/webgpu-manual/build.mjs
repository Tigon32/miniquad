#!/usr/bin/env node
// One build command for the manual WebGPU proof candidate
// (docs/webgpu-proof-contract.md, section 2: "one build command; writes dist/").
// Usage: node build.mjs [--release]
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const cargo = process.env.CARGO ?? "cargo";

const cargoArgs = ["build", "--target", "wasm32-unknown-unknown"];
if (release) cargoArgs.push("--release");

console.log("$ " + cargo + " " + cargoArgs.join(" "));
execFileSync(cargo, cargoArgs, { cwd: here, stdio: "inherit" });

const targetDir = resolve(here, "target", "wasm32-unknown-unknown", profile);
const wasmFiles = readdirSync(targetDir).filter(name => name.endsWith(".wasm"));
if (wasmFiles.length !== 1) {
    throw new Error("expected exactly one .wasm file in " + targetDir + ", found " + wasmFiles.length);
}

const distDir = resolve(here, "dist");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

copyFileSync(join(targetDir, wasmFiles[0]), join(distDir, "app.wasm"));
cpSync(resolve(here, "web", "index.html"), join(distDir, "index.html"));
cpSync(resolve(here, "web", "host.js"), join(distDir, "host.js"));

if (!existsSync(join(distDir, "app.wasm"))) throw new Error("build did not produce dist/app.wasm");
console.log("Built " + profile + " into " + distDir);
