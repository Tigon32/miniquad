const canvas = document.querySelector("#glcanvas");
const requestFrame = window.requestAnimationFrame.bind(window);
const cancelFrame = window.cancelAnimationFrame.bind(window);
const callbacks = new Map();
let nextFrame = 0;
let paused = true;
let disposed = false;
let started = false;
let frameCount = 0;
const startupController = new AbortController();
const fetchResource = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => fetchResource(input, {
    ...init,
    signal: init?.signal
        ? AbortSignal.any([startupController.signal, init.signal])
        : startupController.signal
});

function schedule(id, entry) {
    entry.native = requestFrame(time => {
        entry.native = null;
        if (paused || disposed) return;
        callbacks.delete(id);
        frameCount++;
        entry.callback(time);
    });
}

window.requestAnimationFrame = callback => {
    if (disposed) return 0;
    const id = ++nextFrame;
    const entry = { callback, native: null };
    callbacks.set(id, entry);
    if (!paused) schedule(id, entry);
    return id;
};
window.cancelAnimationFrame = id => {
    const entry = callbacks.get(id);
    if (entry?.native != null) cancelFrame(entry.native);
    callbacks.delete(id);
};

function setPaused(value) {
    if (disposed) throw new Error("Runtime is disposed");
    if (paused === value) return;
    paused = value;
    if (paused) canvas.blur();
    for (const [id, entry] of callbacks) {
        if (paused && entry.native != null) {
            cancelFrame(entry.native);
            entry.native = null;
        } else if (!paused && entry.native == null) {
            schedule(id, entry);
        }
    }
}

globalThis.miniquad_auto_focus = false;
const ready = new Promise((resolve, reject) => {
    const bridge = document.createElement("script");
    bridge.src = new URL("./gl.js", import.meta.url).href;
    bridge.onload = () => resolve();
    bridge.onerror = () => reject(new Error("Cannot load the matching Miniquad bridge"));
    document.head.append(bridge);
});
ready.catch(() => {});

globalThis.miniquadRuntime = {
    ready,
    get frames() { return frameCount; },
    get pendingFrames() { return callbacks.size; },
    async start(url, initiallyPaused) {
        await ready;
        if (disposed) throw new Error("Runtime is disposed");
        if (started) throw new Error("Runtime already started");
        started = true;
        await globalThis.load(url);
        if (disposed) throw new Error("Runtime is disposed");
        setPaused(initiallyPaused);
    },
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    focus() { canvas.focus(); },
    get exports() { return globalThis.wasm_exports; },
    dispose() {
        if (disposed) return;
        setPaused(true);
        disposed = true;
        globalThis.miniquad_disposed = true;
        startupController.abort();
        callbacks.clear();
        const context = globalThis.gl;
        if (context && !context.isContextLost()) {
            context.getExtension("WEBGL_lose_context")?.loseContext();
        }
        globalThis.wasm_exports = null;
        globalThis.wasm_memory = null;
    }
};
