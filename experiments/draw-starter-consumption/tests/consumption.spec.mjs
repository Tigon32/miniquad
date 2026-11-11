// Issue #123 qualification: proves a *generated* browser starter (not
// a hand-authored fixture) renders real geometry through the
// miniquad-draw companion's public API, consumed as a pinned Git
// dependency at the same revision as the starter's own miniquad
// dependency. See docs/browser-starter-drawing.md for the recipe and
// experiments/draw-starter-consumption/ for the generator script and
// isolated Playwright config (port 4282) this spec runs under.
//
// Uses the same explicit, non-blank pixel-sampling approach as
// tests/browser/drawing.spec.mjs (background / rectangle / circle),
// not a single blank-frame hash check.
import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

function readRGBA(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

async function screenshotCanvas(page) {
    const canvas = page.frameLocator("#host iframe").locator("#glcanvas");
    return PNG.sync.read(await canvas.screenshot());
}

function collectErrors(page) {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
    });
    return errors;
}

test.describe("generated starter: miniquad-draw consumption proof", () => {
    test("renders the companion's rectangle and circle through a Git-pinned dependency", async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto("/");
        await page.waitForFunction(() => window.document.getElementById("status")?.dataset.state === "running");

        const image = await screenshotCanvas(page);
        for (const [x, y, expected] of [
            [0.05, 0.05, [26, 26, 31]],
            [0.3, 0.3, [217, 51, 51]],
            [0.65, 0.6, [51, 128, 230]],
        ]) {
            const actual = readRGBA(image, Math.floor(image.width * x), Math.floor(image.height * y));
            for (let channel = 0; channel < 3; channel++) {
                expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(2);
            }
        }
        expect(errors).toEqual([]);
    });

    test("drops the Parameters controls but keeps Pause/Resume/Focus", async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto("/");
        await page.waitForFunction(() => window.document.getElementById("status")?.dataset.state === "running");

        // The generated page's own template disables "#parameters" unless
        // `app.supportsParameters` is true after `app.ready` resolves (see
        // templates/browser/web/index.html.template). The drawing-only
        // application has no mq_params_* exports, so this must stay
        // disabled -- this is the faithful, template-driven proxy for
        // `app.supportsParameters === false`, since the module script
        // keeps `app` in its own closure, not on `window`. Reads the
        // DOM property directly: Playwright's locator.isDisabled() does
        // not reliably reflect a <fieldset disabled> element's state.
        const parametersDisabled = await page.evaluate(
            () => document.getElementById("parameters").disabled
        );
        expect(parametersDisabled).toBe(true);

        await page.locator("#pause").click();
        await page.waitForFunction(() => window.document.getElementById("status")?.dataset.state === "paused");
        await page.locator("#resume").click();
        await page.waitForFunction(() => window.document.getElementById("status")?.dataset.state === "running");
        await expect(page.locator("#focus-app")).toBeEnabled();
        await page.locator("#focus-app").click();
        await expect(page.frameLocator("#host iframe").locator("#glcanvas")).toBeFocused();
        expect(errors).toEqual([]);
    });
});
