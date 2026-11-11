import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

async function mountScene(page, options = {}) {
    await page.evaluate(async options => {
        const { mount } = await import("/js/miniquad.mjs");
        window.app = mount({
            container: document.querySelector("#scene"), wasmURL: "/quad.wasm", ...options
        });
        await app.ready;
    }, options);
}

test.beforeEach(async ({ page }) => {
    await page.goto("/embed");
});

test("parameter support requires the complete optional export surface", async ({ page }) => {
    await page.route("**/incomplete-runtime.html", route => route.fulfill({
        contentType: "text/html",
        body: `<canvas id="glcanvas"></canvas><script>
        window.miniquadRuntime = {
            start: async () => {},
            dispose: () => {},
            exports: { mq_params_version: () => 1 }
        };
        </script>`
    }));
    await mountScene(page, { runtimeURL: "/incomplete-runtime.html" });
    expect(await page.evaluate(() => app.supportsParameters)).toBe(false);
    expect(await page.evaluate(() => {
        try { app.setParameters({ speed: 1 }); }
        catch (error) { return error.code; }
    })).toBe("parameters-unsupported");
    await page.evaluate(() => app.dispose());
});

test("embedding draws pixels, preserves host focus, resizes, pauses, and remounts", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.locator("#host-input").focus();
    await mountScene(page);
    await expect(page.locator("#host-input")).toBeFocused();
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 2);
    const canvas = page.frameLocator("#scene iframe").locator("#glcanvas");
    const image = PNG.sync.read(await canvas.screenshot());
    let colored = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i] > 24 || image.data[i + 1] > 24 || image.data[i + 2] > 24) colored++;
    }
    expect(colored).toBeGreaterThan(50);
    await page.evaluate(() => { document.querySelector("#scene").style.width = "300px"; });
    await expect(canvas).toHaveJSProperty("width", 300);
    const pausedAt = await page.evaluate(() => {
        app.pause();
        return app.frame.contentWindow.miniquadRuntime.frames;
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => app.frame.contentWindow.miniquadRuntime.frames)).toBe(pausedAt);
    await page.evaluate(() => app.resume());
    await page.waitForFunction(count => app.frame.contentWindow.miniquadRuntime.frames > count, pausedAt);
    await page.evaluate(() => app.focus());
    expect(await page.evaluate(() => app.frame.contentDocument.activeElement.id)).toBe("glcanvas");
    await page.evaluate(() => {
        const runtime = app.frame.contentWindow.miniquadRuntime;
        app.dispose();
        app.dispose();
        window.disposedPending = runtime.pendingFrames;
    });
    expect(await page.evaluate(() => ({ state: app.state, pending: disposedPending, frame: app.frame })))
        .toEqual({ state: "disposed", pending: 0, frame: null });
    await expect(page.locator("#scene iframe")).toHaveCount(0);
    await mountScene(page);
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 1);
    expect(errors).toEqual([]);
});

test("initial pause and isolated instances do not share application state", async ({ page }) => {
    await mountScene(page, { paused: true });
    await page.waitForTimeout(80);
    expect(await page.evaluate(() => app.frame.contentWindow.miniquadRuntime.frames)).toBe(0);
    expect(await page.evaluate(() => app.state)).toBe("paused");
    await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        window.second = mount({ container: document.querySelector("#second"), wasmURL: "/quad.wasm" });
        await second.ready;
    });
    await page.waitForFunction(() => second.frame.contentWindow.miniquadRuntime.frames > 1);
    await page.evaluate(() => second.dispose());
    expect(await page.evaluate(() => app.state)).toBe("paused");
    await page.evaluate(() => app.resume());
    await page.waitForFunction(() => app.frame.contentWindow.miniquadRuntime.frames > 0);
});

test("startup disposal rejects promptly and removes the isolated runtime", async ({ page }) => {
    await page.route("**/quad.wasm", route => route.abort());
    const result = await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        const app = mount({ container: document.querySelector("#scene"), wasmURL: "/quad.wasm" });
        app.dispose();
        try { await app.ready; } catch (error) {
            return { code: error.code, state: app.state, frames: document.querySelectorAll("iframe").length };
        }
    });

    expect(result).toEqual({ code: "disposed", state: "disposed", frames: 0 });
});

test("disposing during an actual WASM fetch cancels startup", async ({ page }) => {
        let received;
        const requested = new Promise(resolve => { received = resolve; });
        await page.route("**/quad.wasm", async route => {
            received();
            await new Promise(resolve => setTimeout(resolve, 200));
            await route.abort();
        });
        await page.evaluate(async () => {
            const { mount } = await import("/js/miniquad.mjs");
            window.app = mount({ container: document.querySelector("#scene"), wasmURL: "/quad.wasm" });
            window.startupResult = app.ready.then(() => "unexpected success", error => error.code);
        });
        await requested;
        await page.evaluate(() => app.dispose());
        expect(await page.evaluate(() => startupResult)).toBe("disposed");
        await expect(page.locator("#scene iframe")).toHaveCount(0);
    });

    test("uncaught scene errors stop frames and reach the host", async ({ page }) => {
        await mountScene(page);
        const code = await page.evaluate(() => new Promise(resolve => {
            app.frame.addEventListener("miniquaderror", event => resolve(event.detail.code));
            const fail = app.frame.contentWindow.Function("throw new Error('Scene error receipt')");
            app.frame.contentWindow.setTimeout(fail, 0);
        }));
        expect(code).toBe("runtime-error");
        expect(await page.evaluate(() => app.state)).toBe("failed");
        const frames = await page.evaluate(() => app.frame.contentWindow.miniquadRuntime.frames);
        await page.waitForTimeout(80);
        expect(await page.evaluate(() => app.frame.contentWindow.miniquadRuntime.frames)).toBe(frames);
        await page.evaluate(() => app.dispose());
    });
test("missing WASM, unsupported parameters and cross-origin URLs fail visibly", async ({ page }) => {
    await page.route("**/missing.wasm", route => route.fulfill({ status: 404, body: "missing" }));
    expect(await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        const app = mount({ container: document.querySelector("#scene"), wasmURL: "/missing.wasm" });
        try { await app.ready; } catch (error) { return error.code; }
    })).toBe("startup");
    await expect(page.locator("#scene iframe")).toHaveCount(0);
    await mountScene(page);
    expect(await page.evaluate(() => {
        try { app.setParameters({ speed: 1 }); } catch (error) { return error.code; }
    })).toBe("parameters-unsupported");
    expect(await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        try { mount({ container: document.querySelector("#second"), wasmURL: "https://example.invalid/app.wasm" }); }
        catch (error) { return error.code; }
    })).toBe("cross-origin");
});

test("abort after initialization disposes and context loss requires remount", async ({ page }) => {
    await mountScene(page);
    expect(await page.evaluate(async () => {
        const lost = new Promise(resolve => app.frame.addEventListener("miniquaderror", event => resolve(event.detail.code)));
        app.frame.contentWindow.gl.getExtension("WEBGL_lose_context").loseContext();
        return lost;
    })).toBe("context-lost");
    expect(await page.evaluate(() => app.state)).toBe("context-lost");
    await page.evaluate(() => app.dispose());
    expect(await page.evaluate(async () => {
        const { mount } = await import("/js/miniquad.mjs");
        const controller = new AbortController();
        const app = mount({ container: document.querySelector("#scene"), wasmURL: "/quad.wasm", signal: controller.signal });
        await app.ready;
        controller.abort();
        return app.state;
    })).toBe("disposed");
});
