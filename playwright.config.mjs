import { defineConfig, devices } from "@playwright/test";

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium","firefox","webkit"];
if (browser && !known.includes(browser)) {
  throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}

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
  projects: known.filter(name=>!browser || browser===name).map(name=>({
    name,
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
  webServer: {
    command: "node tests/browser/serve.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 20000
  }
});
