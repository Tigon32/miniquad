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
  rmSync,
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

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Resolves the exact commit this checkout is at, so the fixture always
 * targets a revision this repository can itself verify (never a
 * hard-coded SHA that could silently drift from the checkout). */
export function resolveHeadSha({ execFileSyncImpl = execFileSync } = {}) {
  return execFileSyncImpl("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
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
  if (!original.includes(expectedMiniquadLine)) {
    fail(
      `Expected to find this exact miniquad dependency line in ` +
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

/** The generated starter's src/main.rs, replaced with application code
 * that calls only `miniquad-draw`'s public API (Batch, Color, Rect,
 * Renderer, Transform2D), in the same shape as the path-dependency
 * reference fixture at
 * experiments/drawing-comparison/external-consumer/examples/consume.rs.
 * No file from companions/draw/ is copied here.
 *
 * The starter's `mq_params_*` exports (speed / foreground / background)
 * are intentionally dropped: see "Which optional host controls remain
 * available" in docs/browser-starter-drawing.md. Pause/Resume/Focus are
 * unaffected -- they do not depend on these exports. */
export const DRAWING_MAIN_RS = `//! Issue #123 generated-starter consumption proof.
//!
//! This file replaces the default starter's animated-quad application
//! with one that only calls \`miniquad-draw\`'s public API. See
//! \`docs/browser-starter-drawing.md\` for the recipe and for exactly
//! which optional host controls (the "Parameters" fieldset) are
//! unavailable as a result -- Pause, Resume, and Focus keep working.
use miniquad::*;
use miniquad_draw::{Batch, Color, Rect, Renderer, Transform2D};

struct Stage {
    ctx: Box<dyn RenderingBackend>,
    renderer: Renderer,
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let renderer = Renderer::new(ctx.as_mut());
        Stage { ctx, renderer }
    }
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        let (width, height) = window::screen_size();

        let mut batch = Batch::new();
        batch
            .rectangle(
                Rect::new(width * 0.2, height * 0.2, width * 0.3, height * 0.3),
                Color::new(0.85, 0.2, 0.2, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("fixture rectangle stays in bounds");
        batch
            .circle(
                (width * 0.65, height * 0.6),
                (width.min(height) * 0.15).max(1.0),
                24,
                Color::new(0.2, 0.5, 0.9, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("fixture circle radius and segment count stay in bounds");

        self.ctx
            .begin_default_pass(PassAction::clear_color(0.1, 0.1, 0.12, 1.0));
        self.renderer.draw(self.ctx.as_mut(), &batch, (width, height));
        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf::default();
    miniquad::start(conf, move || Box::new(Stage::new()));
}
`;

export function generateFixture({ execFileSyncImpl = execFileSync } = {}) {
  if (existsSync(FIXTURE_DEST)) {
    rmSync(FIXTURE_DEST, { recursive: true, force: true });
  }

  const rev = resolveHeadSha({ execFileSyncImpl });

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

  writeFileSync(join(FIXTURE_DEST, "src", "main.rs"), DRAWING_MAIN_RS);
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
    fail(error.message);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
