#!/usr/bin/env node
// Issue #123 qualification: proves a *generated* browser starter (the
// issue #124 generator, `scripts/create-browser-project.mjs`) can add
// the optional `miniquad-draw` companion as a second Git dependency,
// pinned to the same revision as its `miniquad` dependency, and still
// build and render through only the companion's public API. See
// `docs/browser-starter-drawing.md` for the full recipe and the trap
// this avoids.
//
// This script never edits `companions/draw/` or
// `scripts/create-browser-project.mjs`: it only invokes the existing
// generator, then edits the files *it* wrote in a fresh, isolated
// destination.
//
// Usage: node experiments/draw-starter-consumption/generate-fixture.mjs

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const FIXTURE_NAME = "draw-starter-consumption-proof";
export const FIXTURE_DEST = join(
  REPO_ROOT,
  ".generator-test-scratch",
  FIXTURE_NAME
);
const GIT_URL = "https://github.com/Tigon32/miniquad.git";
export const FIXTURE_SOURCE_SHA = "de6bff785d1ec71bad1b47ef032d19405c6fd7e2";
const APPLICATION_PATH = "experiments/drawing-comparison/external-consumer/examples/consume.rs";

function fail(message) {
  throw new Error(message);
}

/** Adds `miniquad-draw` to the generated project's [dependencies],
 * pinned to the exact same git URL and rev as the existing `miniquad`
 * entry the generator already wrote. Fails loudly if the expected
 * `miniquad` git dependency line is not present (for example if the
 * generator changed its Cargo.toml.template shape), rather than
 * silently appending a possibly-mismatched pin. */
export function addMiniquadDrawDependency(destination, rev) {
  const cargoTomlPath = join(destination, "Cargo.toml");
  const original = readFileSync(cargoTomlPath, "utf8");
  const expectedMiniquadLine = `miniquad = { git = "${GIT_URL}", rev = "${rev}" }`;
  if (!original.includes(`${expectedMiniquadLine}\n`) || original.includes("miniquad-draw =")) {
    fail(
      `Expected this exact miniquad dependency and no miniquad-draw entry in ` +
        `${cargoTomlPath}:\n  ${expectedMiniquadLine}\n` +
        "Refusing to add miniquad-draw at a possibly different " +
        "revision. See docs/browser-starter-drawing.md."
    );
  }
  const drawLine = `miniquad-draw = { git = "${GIT_URL}", rev = "${rev}" }\n`;
  const updated = original.replace(
    `${expectedMiniquadLine}\n`,
    `${expectedMiniquadLine}\n${drawLine}`
  );
  writeFileSync(cargoTomlPath, updated);
  return { cargoTomlPath, drawLine: drawLine.trim() };
}

export function generateFixture({ execFileSyncImpl = execFileSync } = {}) {
  if (existsSync(FIXTURE_DEST)) {
    fail(`Fixture destination already exists: ${FIXTURE_DEST}. Refusing to overwrite it.`);
  }

  const rev = FIXTURE_SOURCE_SHA;
  console.log(`Fetching the public fixture source at ${rev} ...`);
  execFileSyncImpl("git", ["-C", REPO_ROOT, "fetch", "--no-tags", GIT_URL, rev], { stdio: "inherit" });
  const application = execFileSyncImpl("git", ["-C", REPO_ROOT, "show", `${rev}:${APPLICATION_PATH}`], { encoding: "utf8" });

  console.log(`Generating starter at revision ${rev} ...`);
  execFileSyncImpl(
    process.execPath,
    [
      join(REPO_ROOT, "scripts", "create-browser-project.mjs"),
      FIXTURE_DEST,
      "--source",
      "git",
      "--git-url",
      GIT_URL,
      "--rev",
      rev,
      "--git-repo",
      REPO_ROOT,
      "--name",
      FIXTURE_NAME,
      "--title",
      "Draw starter consumption proof",
    ],
    { stdio: "inherit" }
  );

  const { drawLine } = addMiniquadDrawDependency(FIXTURE_DEST, rev);
  console.log(`Added dependency: ${drawLine}`);

  writeFileSync(join(FIXTURE_DEST, "src", "main.rs"), application);
  console.log("Replaced src/main.rs with a miniquad-draw-only application.");

  console.log("Building for wasm32-unknown-unknown (this fetches the pinned git revision) ...");
  execFileSyncImpl(
    process.execPath,
    [join(FIXTURE_DEST, "scripts", "build.mjs")],
    { stdio: "inherit", cwd: FIXTURE_DEST }
  );

  console.log(`Fixture ready at: ${FIXTURE_DEST}`);
  return { destination: FIXTURE_DEST, rev };
}

function main() {
  try {
    generateFixture();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
