// Private, isolated Playwright config for issue #29's mixed-voxel fixture.
//
// Root's `playwright.config.mjs` (testDir "./tests/browser", testMatch
// "*.spec.mjs") does NOT discover `voxel-mixed.privatefixture.mjs`: this
// fixture's own `beforeAll`/`afterAll` builds and spawns a real native
// `vx-server` child process (companions/voxel/target/release/vx-server)
// and serves two private, separately-built WASM artifacts
// (companions/voxel/target-gl1, companions/voxel/target-gl2) that root
// CI does not build. Discovering and running this file as part of the
// root suite would fail in any environment (including Docker/act) that
// has not run this companion's explicit build steps first.
//
// Required build steps before running this config (see
// docs/architecture/voxel-protocol.md's "GL1/GL2 build artifacts"
// section for the exact commands):
//   cargo build --release --bin vx-server --manifest-path companions/voxel/Cargo.toml
//   cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml
//   cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml --target-dir companions/voxel/target-gl1
//   cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml --features webgl2 --target-dir companions/voxel/target-gl2
//
// Run with (optionally set MINIQUAD_BROWSER=chromium|firefox|webkit to
// restrict to one engine):
//   npx playwright test --config=tests/browser/voxel-mixed.playwright.config.mjs
//
// This fixture's own servers bind to ports 4230 (vx-server) and 4231
// (private test forwarder), independent of root's `tests/browser/serve.mjs`
// (port 4173), so no root `webServer` entry is declared here.
import { defineConfig, devices } from "@playwright/test";

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium", "firefox", "webkit"];
if (browser && !known.includes(browser)) {
  throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}

export default defineConfig({
  // "." is this config file's own directory (tests/browser), not the
  // repo root - relative paths in a Playwright config resolve against
  // the directory that holds the config file.
  testDir: ".",
  testMatch: "**/voxel-mixed.privatefixture.mjs",
  // Shares root's top-level test-results/ directory (not this config's
  // default "tests/browser/test-results") so existing CI steps that
  // upload test-results/ on failure also capture this fixture's
  // traces/screenshots without a new, separately-owned artifact step.
  outputDir: "../../test-results/voxel-mixed",
  timeout: 45000,
  expect: { timeout: 20000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: process.env.MINIQUAD_HEADFUL !== "1",
  },
  projects: known
    .filter((name) => !browser || browser === name)
    .map((name) => ({
      name,
      use: {
        ...devices[
          name === "chromium"
            ? "Desktop Chrome"
            : name === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        viewport: { width: 800, height: 500 },
        launchOptions:
          name === "chromium"
            ? {
                args: [
                  "--enable-webgl",
                  "--enable-unsafe-swiftshader",
                  "--use-gl=angle",
                  "--use-angle=swiftshader",
                ],
              }
            : {},
      },
    })),
});
