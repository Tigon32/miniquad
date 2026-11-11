// Own, isolated Playwright config for the drawing-companion browser
// qualification (issue #123). Deliberately separate from the parent's
// root `playwright.config.mjs` (port 4173, `tests/browser/serve.mjs`):
// this session owns only `tests/browser/drawing.spec.mjs` and must not
// run the parent's Playwright config concurrently on the same port. See
// `experiments/drawing-comparison/serve-drawing.mjs` (own server, port
// 4280) and `docs/drawing-companion.md` for the exact command.
import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium", "firefox", "webkit"];
if (browser && !known.includes(browser)) {
  throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}
const port = Number(process.env.DRAWING_QUALIFICATION_PORT || 4280);

export default defineConfig({
  testDir: resolve(repoRoot, "tests/browser"),
  testMatch: "drawing.spec.mjs",
  timeout: 45000,
  expect: { timeout: 20000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:" + port,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: process.env.MINIQUAD_HEADFUL !== "1",
  },
  projects: [
    ...known
      .filter((name) => !browser || browser === name)
      .map((name) => ({
        name,
        // The DPR-specific projects below own the "device pixel ratio"
        // describe block; every other project runs everything else once
        // at the engine's default scale factor.
        grepInvert: /device pixel ratio/,
        use: {
          ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"],
          viewport: { width: 800, height: 500 },
          launchOptions:
            name === "chromium"
              ? { args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] }
              : {},
        },
      })),
    // DPR 1 and DPR 2, Chromium only: `deviceScaleFactor` is a launch-time
    // context option, so each ratio needs its own project rather than a
    // runtime toggle. Firefox/WebKit DPR emulation is left to the parent's
    // own 3-engine qualification pass (see docs/drawing-companion.md).
    ...(!browser || browser === "chromium"
      ? [1, 2].map((dpr) => ({
          name: `chromium-dpr${dpr}`,
          grep: /device pixel ratio/,
          use: {
            ...devices["Desktop Chrome"],
            viewport: { width: 800, height: 500 },
            deviceScaleFactor: dpr,
            launchOptions: { args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] },
          },
        }))
      : []),
  ],
  webServer: {
    command: "node " + resolve(here, "serve-drawing.mjs"),
    url: "http://127.0.0.1:" + port + "/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
