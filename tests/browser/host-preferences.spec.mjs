import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Self-contained fixture for issue #122. This spec does not depend on the
// shared smoke/serve fixtures or on any real WASM scene: it intercepts one
// virtual module URL and serves the actual js/host-preferences.mjs source
// from disk, then builds a minimal semantic-HTML host page with
// page.setContent(). Parent work integrates a real mounted application;
// here the "application" is a small recording fake that stands in for the
// mount handle contract (pause/resume/setParameters/supportsParameters).

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, "../../js/host-preferences.mjs");
const MODULE_URL = "https://host-preferences.invalid/host-preferences.mjs";

async function routeModule(page) {
  const source = await readFile(modulePath, "utf8");
  await page.route(MODULE_URL, (route) => {
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: source });
  });
}

const HOST_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  #scene { --miniquad-foreground: #ff0000; --miniquad-background: #000000; }
</style>
</head>
<body>
<main id="scene" aria-describedby="scene-description">
  <p id="scene-description">Animated reference scene. A host application renders this area.</p>
  <div role="status" id="status" aria-live="polite"></div>
  <button id="pause-button" type="button">Pause</button>
  <button id="resume-button" type="button">Resume</button>
</main>
<script type="module">
  import { createHostPreferences } from "${MODULE_URL}";
  window.__calls = [];
  window.__errors = [];
  window.__application = {
    supportsParameters: true,
    setParameters(partial) { window.__calls.push(["setParameters", partial]); },
    pause() { window.__calls.push(["pause"]); document.getElementById("status").textContent = "paused"; },
    resume() { window.__calls.push(["resume"]); document.getElementById("status").textContent = "running"; }
  };
  window.__handle = createHostPreferences({
    element: document.getElementById("scene"),
    application: window.__application,
    onError(error) { window.__errors.push(error.message); document.getElementById("status").textContent = "error: " + error.message; }
  });
  document.getElementById("pause-button").addEventListener("click", () => window.__handle.setMotionOverride("paused"));
  document.getElementById("resume-button").addEventListener("click", () => window.__handle.setMotionOverride("running"));
</script>
</body>
</html>`;

test("starts paused before any frame when reduced motion is already preferred", async ({ page }) => {
  await routeModule(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  await expect(page.locator("#status")).toHaveText("paused");
  const calls = await page.evaluate(() => window.__calls);
  assertNoDuplicateTrailingCalls(calls);
  expect(calls).toContainEqual(["pause"]);
  expect(errors).toEqual([]);
});

test("resumes when reduced motion is not preferred", async ({ page }) => {
  await routeModule(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  await expect(page.locator("#status")).toHaveText("running");
});

test("a live reduced-motion change pauses a running scene", async ({ page }) => {
  await routeModule(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  await expect(page.locator("#status")).toHaveText("running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#status")).toHaveText("paused");
});

test("applies the host palette from CSS custom properties on load", async ({ page }) => {
  await routeModule(page);
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  const calls = await page.evaluate(() => window.__calls);
  const paletteCall = calls.find((entry) => entry[0] === "setParameters" && "foreground" in entry[1]);
  expect(paletteCall[1]).toEqual({ foreground: [1, 0, 0, 1], background: [0, 0, 0, 1] });
});

test("an invalid custom property surfaces a visible error, not a silent success", async ({ page }) => {
  await routeModule(page);
  const brokenPage = HOST_PAGE.replace("--miniquad-foreground: #ff0000;", "--miniquad-foreground: not-a-color;");
  await page.setContent(brokenPage, { waitUntil: "load" });
  await expect(page.locator("#status")).toContainText("error:");
  const errors = await page.evaluate(() => window.__errors);
  expect(errors.some((message) => message.includes("foreground"))).toBe(true);
});

test("forced-colors is reported in state without claiming automatic WebGL recoloring", async ({ page }) => {
  await routeModule(page);
  await page.emulateMedia({ forcedColors: "active" });
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  const state = await page.evaluate(() => window.__handle.getState());
  expect(state.forcedColors).toBe(true);
});

test("dispose() removes listeners: a later media change is not observed", async ({ page }) => {
  await routeModule(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(HOST_PAGE, { waitUntil: "load" });
  await page.evaluate(() => { window.__handle.dispose(); window.__calls.length = 0; });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(50);
  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toEqual([]);
});

// WebKit's default keyboard-navigation mode (macOS Safari's "Full Keyboard
// Access" preference off, the factory default) moves plain Tab focus only
// between text fields, not buttons. Safari's own documented alternative in
// that mode is Option-Tab ("Alt+Tab" in Playwright's cross-platform key
// names) to move focus to the next control, including a <button>. See
// Safari > Settings > Advanced, "Press Tab to highlight each item on a web
// page" (default off), and the confirmed Playwright WebKit behavior in
// https://github.com/microsoft/playwright/issues/41808. Chromium and
// Firefox tab to buttons by default, so only WebKit needs the alternate
// key. This keeps the assertion itself (the next button receives focus)
// unchanged across engines; it does not add a tabindex or relax the check.
function nextControlKey(browserName) {
  return browserName === "webkit" ? "Alt+Tab" : "Tab";
}

for (const width of [320, 1280, 1440]) {
  test(`keyboard-only pause/resume works at ${width}px width`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 640 });
    await routeModule(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setContent(HOST_PAGE, { waitUntil: "load" });
    await expect(page.locator("#status")).toHaveText("running");

    await page.locator("#pause-button").focus();
    await expect(page.locator("#pause-button")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toHaveText("paused");

    await page.keyboard.press(nextControlKey(browserName));
    await expect(page.locator("#resume-button")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator("#status")).toHaveText("running");
  });
}

function assertNoDuplicateTrailingCalls(calls) {
  for (let index = 1; index < calls.length; index += 1) {
    if (calls[index][0] === "pause" && calls[index - 1][0] === "pause") {
      throw new Error("pause() was called twice in a row");
    }
  }
}
