import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { PNG } from "pngjs";

const project = resolve(process.env.MINIQUAD_STARTER_PATH || "target/browser-starter");
const address = "http://127.0.0.1:4174/demo/";
let server;

test.beforeAll(async () => {
    let output = "";
    let spawnError;
    server = spawn(process.execPath, [
        join(project, "scripts/serve.mjs"), "--port", "4174", "--base", "/demo"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    server.on("error", error => { spawnError = error; });
    server.stdout.on("data", data => { output += data; });
    server.stderr.on("data", data => { output += data; });
    for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError || server.exitCode !== null) {
            throw new Error("Cannot start the generated consumer server: " + (spawnError?.message || output));
        }
        try {
            const response = await fetch(address);
            if (response.ok) return;
        } catch (error) {
            if (error.cause?.code !== "ECONNREFUSED") throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Generated consumer server did not become ready: " + output);
});

test.afterAll(async () => {
    if (server && server.exitCode === null && server.pid) {
        const stopped = once(server, "exit");
        server.kill("SIGTERM");
        await stopped;
    }
});

test("external starter renders under a deployment subpath and changes real WASM parameters", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(address);
    await expect(page.locator("#status")).toHaveAttribute("data-state", "running");
    const canvas = page.frameLocator("#host iframe").locator("#glcanvas");
    await expect(canvas).toBeVisible();
    await page.locator("#background").fill("#112233");
    await page.locator("#background").dispatchEvent("input");
    await page.waitForTimeout(100);
    const image = PNG.sync.read(await canvas.screenshot());
    expect([...image.data.subarray(0, 3)]).toEqual([17, 34, 51]);
    const contract = await page.locator("#host iframe").evaluate(frame => {
        const exports = frame.contentWindow.miniquadRuntime.exports;
        return {
            version: exports.mq_params_version(),
            invalidId: exports.mq_param_set_f32(9, 1),
            invalidSpeed: exports.mq_param_set_f32(1, NaN),
            colorId: exports.mq_param_set_rgba8(9, 0)
        };
    });
    expect(contract.version).toBe(1);
    for (const result of [contract.invalidId, contract.invalidSpeed, contract.colorId]) {
        expect(result).not.toBe(0);
    }
    await page.locator("#pause").click();
    await expect(page.locator("#status")).toHaveAttribute("data-state", "paused");
    await page.locator("#resume").click();
    await expect(page.locator("#status")).toHaveAttribute("data-state", "running");
    expect(errors).toEqual([]);
});

for (const width of [320, 1280, 1440]) {
    test(`starter supports host preferences and reduced motion at ${width}px`, async ({ page }) => {
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await page.goto(address);
        await expect(page.locator("#status")).toHaveAttribute("data-state", "paused");
        expect(await page.locator("#host iframe").evaluate(frame =>
            frame.contentWindow.miniquadRuntime.frames)).toBe(0);
        await page.locator("#resume").click();
        await expect(page.locator("#status")).toHaveAttribute("data-state", "running");
        for (const media of [
            { colorScheme: "light", contrast: "no-preference", forcedColors: "none" },
            { colorScheme: "dark", contrast: "no-preference", forcedColors: "none" },
            { colorScheme: "light", contrast: "more", forcedColors: "none" },
            { colorScheme: "dark", contrast: "more", forcedColors: "active" }
        ]) {
            await page.emulateMedia(media);
            await expect(page.locator("#status")).not.toHaveAttribute("data-state", "error");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await page.frameLocator("#host iframe").locator("#glcanvas").screenshot();
        }
        expect(errors).toEqual([]);
    });
}
