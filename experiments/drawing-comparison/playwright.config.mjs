// Own, isolated Playwright config for the drawing-companion browser
// qualification. Separate from the root `playwright.config.mjs` (port
// 4173, `tests/browser/serve.mjs`). See `serve-drawing.mjs` (own
// server, port 4280) and `docs/drawing-companion.md` for the command.
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
        use: {
          ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"],
          viewport: { width: 800, height: 500 },
          launchOptions:
            name === "chromium"
              ? { args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] }
              : {},
        },
      })),
  ],
  webServer: {
    command: "node " + resolve(here, "serve-drawing.mjs"),
    url: "http://127.0.0.1:" + port + "/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
