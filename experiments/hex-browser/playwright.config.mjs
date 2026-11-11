// Private Playwright config for issue #131's offline hex browser
// slice. Deliberately separate from the repository-root
// `playwright.config.mjs` (parent-owned): this config only runs
// `experiments/hex-browser/tests/hex-offline.spec.mjs`, on port 4290, and
// rebuilds its own WASM fixtures before serving them (see
// build-fixtures.mjs) so a run never silently reuses a stale or
// prebuilt artifact.
//
// Run from the repository root, e.g.:
//   npx playwright test --config=experiments/hex-browser/playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";

const browser = process.env.MINIQUAD_BROWSER;
const known = ["chromium", "firefox", "webkit"];
if (browser && !known.includes(browser)) {
    throw new Error("Invalid MINIQUAD_BROWSER: " + browser);
}

export default defineConfig({
    testDir: "./tests",
    testMatch: "hex-offline.spec.mjs",
    timeout: 45000,
    expect: { timeout: 20000 },
    retries: 0,
    // Sequential cases only, one worker: this harness shares a
    // physical, non-dedicated machine with sibling agents' browser
    // runs.
    workers: 1,
    reporter: [["list"]],
    globalSetup: "./global-setup.mjs",
    use: {
        baseURL: "http://127.0.0.1:4290",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        headless: process.env.MINIQUAD_HEADFUL !== "1"
    },
    projects: known
        .filter(name => !browser || browser === name)
        .map(name => ({
            name,
            use: {
                ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"],
                viewport: { width: 800, height: 500 },
                // Override the "Desktop Safari" device descriptor's
                // `deviceScaleFactor: 2` default. Most cases in this
                // suite read canvas backing-store pixels directly and
                // assume DPR 1 unless they explicitly create their
                // own context with a chosen `deviceScaleFactor` (see
                // the DPR 1/2 cases below); without this override,
                // only WebKit silently doubled every backing-store
                // pixel dimension and broke those default-DPR cases.
                deviceScaleFactor: 1,
                launchOptions:
                    name === "chromium"
                        ? { args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] }
                        : {}
            }
        })),
    webServer: {
        command: "node experiments/hex-browser/server.mjs",
        cwd: "../../",
        url: "http://127.0.0.1:4290/health",
        reuseExistingServer: false,
        timeout: 20000
    }
});
