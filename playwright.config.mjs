import { defineConfig, devices } from "@playwright/test";

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium","firefox","webkit"];
if (browser && !known.includes(browser)) {
  throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}

// Issue #145's acceptance test needs a real hardware graphics adapter, not
// the SwiftShader software rasterizer every other Chromium project forces
// below. This project is the only one that runs
// `gpu-timer-query.spec.mjs`; the three software-rasterizer projects
// explicitly skip it with `testIgnore` so they never claim a GPU result
// they cannot give. See MADR 0023.
const gpuTimerQuerySpec = "gpu-timer-query.spec.mjs";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.mjs",
  timeout: 45000,
  expect: {timeout: 20000},
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {baseURL: "http://127.0.0.1:4173",trace:"retain-on-failure",screenshot:"only-on-failure",
    headless: process.env.MINIQUAD_HEADFUL !== "1"},
  projects: [
    ...known.filter(name=>!browser || browser===name).map(name=>({
      name,
      testIgnore: gpuTimerQuerySpec,
      use: {
        ...devices[name==="chromium"?"Desktop Chrome":name==="firefox"?"Desktop Firefox":"Desktop Safari"],
        viewport:{width:800,height:500},
        ...(name==="firefox" && process.env.MINIQUAD_FIREFOX_PRIVACY==="1" ? {
          firefoxUserPrefs: {
            "privacy.resistFingerprinting": true,
            "privacy.reduceTimerPrecision": true,
            "privacy.resistFingerprinting.reduceTimerPrecision.microseconds": 100000
          }
        } : {}),
        launchOptions:name==="chromium"?{
          args:["--enable-webgl","--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader"]
        }:{}
      }
    })),
    ...((!browser || browser==="chromium") ? [{
      name: "chromium-hardware-gpu",
      testMatch: gpuTimerQuerySpec,
      use: {
        ...devices["Desktop Chrome"],
        viewport:{width:800,height:500},
        launchOptions: {
          // No `--use-angle=swiftshader` and no `--enable-unsafe-swiftshader`:
          // this project must use the real hardware ANGLE backend so the
          // nonzero GPU timer-query result is not a software-rasterizer
          // artifact.
          args:["--enable-webgl","--use-gl=angle","--ignore-gpu-blocklist","--ignore-gpu-blacklist"]
        }
      }
    }] : [])
  ],
  webServer: {
    command: "node tests/browser/serve.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 20000
  }
});

