import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("offline voxel terrain renders and the camera accepts keyboard input", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/embed");
    await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        window.app = mount({
            container: document.querySelector("#scene"), wasmURL: "/voxel.wasm",
            title: "Offline voxel scene"
        });
        await app.ready;
        app.setParameters({ speed: 0 });
    });
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 2);
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    const before = await canvas.screenshot();
    const image = PNG.sync.read(before);
    const colors = new Set();
    for (let i = 0; i < image.data.length; i += 4) {
        colors.add(image.data.subarray(i, i + 4).toString("hex"));
    }
    expect(colors.size).toBeGreaterThan(8);
    await page.evaluate(() => app.focus());
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 10);
    expect((await canvas.screenshot()).equals(before)).toBe(false);
    await page.evaluate(() => app.dispose());
    expect(errors).toEqual([]);
});
