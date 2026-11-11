// Private Playwright config for the hex-2d browser suite only (port 4292).
// The tests start their own fixture server. Keep them outside root
// discovery so they run only with this configuration and built assets.
import { defineConfig, devices } from "@playwright/test";

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium", "firefox", "webkit"];
if (browser && !known.includes(browser)) {
  throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "hex-2d.spec.mjs",
  timeout: 45000,
  expect: { timeout: 20000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: process.env.MINIQUAD_HEADFUL !== "1"
  },
  projects: known.filter(name => !browser || browser === name).map(name => ({
    name,
    use: {
      ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"],
      // The "Desktop Safari" device preset defaults to deviceScaleFactor: 2
      // (simulating a Retina display), while the Chrome/Firefox presets
      // default to 1. That made WebKit alone screenshot the canvas at 2x
      // resolution (960x962 instead of 480x480) even for tests that never
      // opted into dpr 2, breaking every pixel-space assertion in section
      // 4.3. Pin 1 here; the dpr-specific test.describe blocks in
      // hex-2d.spec.mjs already override it with test.use({deviceScaleFactor}).
      deviceScaleFactor: 1,
      viewport: { width: 800, height: 500 },
      launchOptions: name === "chromium" ? {
        args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"]
      } : {}
    }
  }))
});
