import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("optional drawing companion renders geometry through compiled WASM", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/embed");
    await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        window.app = mount({
            container: document.querySelector("#scene"), wasmURL: "/drawing.wasm",
            title: "Drawing companion showcase"
        });
        await app.ready;
    });
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 2);
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    const image = PNG.sync.read(await canvas.screenshot());
    const colors = new Set();
    for (let i = 0; i < image.data.length; i += 4) {
        colors.add(image.data.subarray(i, i + 4).toString("hex"));
    }
    expect(colors.size, "The scene must contain more than a clear color").toBeGreaterThan(8);
    await page.evaluate(() => { document.querySelector("#scene").style.width = "320px"; });
    await expect(canvas).toHaveJSProperty("width", 320);
    await page.evaluate(() => app.dispose());
    expect(errors).toEqual([]);
});
