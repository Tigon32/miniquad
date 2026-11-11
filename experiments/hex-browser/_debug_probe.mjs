import { chromium } from "@playwright/test";
import { CAMERA, hexCellCenter, projectToPixel } from "./camera-math.mjs";

const browser = await chromium.launch({ args: ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto("http://127.0.0.1:4290/?variant=webgl1", { waitUntil: "load" });
await page.waitForFunction(() => typeof window.wasm_exports === "object" && typeof window.wasm_exports.hex_probe_pick === "function");
await page.waitForTimeout(300);

async function probe(px, py) {
    await page.evaluate(([px, py]) => {
        const pxBits = new Uint32Array(new Float32Array([px]).buffer)[0];
        const pyBits = new Uint32Array(new Float32Array([py]).buffer)[0];
        window.wasm_exports.hex_probe_pick(pxBits, pyBits);
    }, [px, py]);
    return page.evaluate(() => ({
        valid: window.wasm_exports.hex_probe_picked_valid(),
        q: window.wasm_exports.hex_probe_picked_q(),
        r: window.wasm_exports.hex_probe_picked_r(),
        layer: window.wasm_exports.hex_probe_picked_layer(),
        face: window.wasm_exports.hex_probe_picked_face()
    }));
}

const viewportPixels = [640, 360];
for (const q of [3, 0, 7]) {
    for (const r of [3, 0, 7]) {
        for (let layer = 2; layer >= 0; layer--) {
            const world = hexCellCenter(q, r, layer);
            const topCenter = [world[0], (layer + 1) * 1.0, world[2]];
            const pixel = projectToPixel(CAMERA, topCenter, viewportPixels);
            const inBounds = pixel && pixel[0] >= 2 && pixel[1] >= 2 && pixel[0] < viewportPixels[0] - 2 && pixel[1] < viewportPixels[1] - 2;
            let result = null;
            if (inBounds) result = await probe(pixel[0], pixel[1]);
            console.log(JSON.stringify({ q, r, layer, pixel, inBounds, result }));
        }
    }
}
await browser.close();
