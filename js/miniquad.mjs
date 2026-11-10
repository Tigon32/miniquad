export class MiniquadError extends Error {
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = "MiniquadError";
        this.code = code;
    }
}

export function validateParameters(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new MiniquadError("invalid-parameters", "Parameters must be an object");
    }
    const entries = Object.entries(values);
    if (entries.length > 3) throw new MiniquadError("invalid-parameters", "Too many parameters");
    for (const [key, value] of entries) {
        if (key === "speed") {
            if (!Number.isFinite(value) || value < 0 || value > 2) {
                throw new MiniquadError("invalid-parameters", "Speed must be between 0 and 2");
            }
        } else if (key === "foreground" || key === "background") {
            if (!Array.isArray(value) || value.length !== 4 ||
                !Array.from(value).every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
                throw new MiniquadError("invalid-parameters", key + " must contain four RGBA channels between 0 and 1");
            }
        } else {
            throw new MiniquadError("invalid-parameters", "Unsupported parameter: " + key);
        }
    }
    return entries;
}

function sameOriginURL(value, base, origin) {
    const url = new URL(value, base);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) {
        throw new MiniquadError("cross-origin", "Runtime and WASM URLs must use the host origin");
    }
    return url.href;
}

export function mount({
    container, wasmURL, runtimeURL = new URL("./runtime.html", import.meta.url),
    title = "Interactive Miniquad scene", signal, paused = false
} = {}) {
    if (!container || container.nodeType !== 1 || !container.ownerDocument?.defaultView) {
        throw new MiniquadError("invalid-container", "Supply a host container element");
    }
    if (typeof paused !== "boolean" || typeof title !== "string" || title.length > 256 || !wasmURL) {
        throw new MiniquadError("invalid-options", "Supply a WASM URL, a short title, and a boolean paused option");
    }
    const document = container.ownerDocument;
    const origin = document.defaultView.location.origin;
    const wasm = sameOriginURL(wasmURL, document.baseURI, origin);
    const runtime = sameOriginURL(runtimeURL, document.baseURI, origin);
    let frame = document.createElement("iframe");
    frame.title = title;
    frame.style.cssText = "display:block;width:100%;height:100%;border:0";
    frame.inert = true;
    let state = "starting";
    let instance = null;
    let contextCanvas = null;
    let runtimeWindow = null;
    let settleReady;
    let rejectReady;
    let settled = false;
    let wantsPause = paused;
    const ready = new Promise((resolve, reject) => {
        settleReady = () => { if (!settled) { settled = true; resolve(); } };
        rejectReady = error => { if (!settled) { settled = true; reject(error); } };
    });
    // The host can attach its handler after synchronous cancellation.
    ready.catch(() => {});

    function assertLive() {
        if (state === "disposed") throw new MiniquadError("disposed", "Application is disposed");
        if (state === "failed" || state === "context-lost") {
            throw new MiniquadError(state, "Dispose and mount a new application");
        }
    }
    function removeListeners() {
        signal?.removeEventListener("abort", abort);
        frame?.removeEventListener("load", start);
        frame?.removeEventListener("error", frameError);
        contextCanvas?.removeEventListener("webglcontextlost", contextLost);
        runtimeWindow?.removeEventListener("error", runtimeError);
        runtimeWindow?.removeEventListener("unhandledrejection", runtimeError);
        runtimeWindow = null;
        contextCanvas = null;
    }
    function cleanup() {
        removeListeners();
        try {
            instance?.dispose();
        } finally {
            frame?.remove();
            frame = null;
            instance = null;
        }
    }
    function fail(code, message, cause) {
        if (state !== "starting") return;
        state = "failed";
        rejectReady(new MiniquadError(code, message, cause));
        cleanup();
    }
    function abort() {
        const error = new MiniquadError("aborted", "Application startup was aborted");
        rejectReady(error);
        state = "disposed";
        cleanup();
    }
    function contextLost() {
        if (state === "disposed") return;
        state = "context-lost";
        frame.inert = true;
        frame.dispatchEvent(new document.defaultView.CustomEvent("miniquaderror", {
            detail: new MiniquadError("context-lost", "WebGL context lost; dispose and mount again")
        }));
    }
    function runtimeError(event) {
        if (state === "disposed" || state === "starting") return;
        instance.pause();
        state = "failed";
        frame.inert = true;
        frame.dispatchEvent(new document.defaultView.CustomEvent("miniquaderror", {
            detail: new MiniquadError("runtime-error", event.message || event.reason?.message || "Application runtime failed")
        }));
    }
    function frameError(event) { fail("runtime-load", "Cannot load the Miniquad runtime", event); }
    async function start() {
        if (state !== "starting") return;
        try {
            instance = frame.contentWindow.miniquadRuntime;
            if (!instance) throw new Error("Runtime module is missing");
            runtimeWindow = frame.contentWindow;
            runtimeWindow.addEventListener("error", runtimeError);
            runtimeWindow.addEventListener("unhandledrejection", runtimeError);
            await instance.start(wasm, wantsPause);
            if (state !== "starting") return;
            contextCanvas = frame.contentDocument.querySelector("#glcanvas");
            contextCanvas.addEventListener("webglcontextlost", contextLost);
            frame.inert = wantsPause;
            state = wantsPause ? "paused" : "running";
            settleReady();
        } catch (error) {
            fail("startup", "Miniquad startup failed: " + error.message, error);
        }
    }
    const handle = {
        ready,
        get state() { return state; },
        get frame() { return frame; },
        get supportsParameters() {
            return instance?.exports?.mq_params_version?.() === 1;
        },
        pause() {
            assertLive();
            wantsPause = true;
            if (state === "starting") return;
            instance.pause();
            frame.inert = true;
            state = "paused";
        },
        resume() {
            assertLive();
            wantsPause = false;
            if (state === "starting") return;
            instance.resume();
            frame.inert = false;
            state = "running";
        },
        focus() {
            assertLive();
            if (state !== "running") throw new MiniquadError("not-running", "Resume the application before focusing it");
            frame.focus();
            instance.focus();
        },
        setParameters(values) {
            assertLive();
            const entries = validateParameters(values);
            const exports = instance?.exports;
            if (!handle.supportsParameters ||
                typeof exports.mq_param_set_f32 !== "function" ||
                typeof exports.mq_param_set_rgba8 !== "function") {
                throw new MiniquadError("parameters-unsupported", "Application does not support parameter contract v1");
            }
            for (const [key, value] of entries) {
                let result;
                if (key === "speed") result = exports.mq_param_set_f32(1, value);
                else {
                    const rgba = value.map(channel => Math.round(channel * 255));
                    const packed = ((rgba[0] << 24) | (rgba[1] << 16) | (rgba[2] << 8) | rgba[3]) >>> 0;
                    result = exports.mq_param_set_rgba8(key === "foreground" ? 1 : 2, packed);
                }
                if (result !== 0) throw new MiniquadError("parameter-rejected", "Application rejected parameter: " + key);
            }
        },
        dispose() {
            if (state === "disposed") return;
            rejectReady(new MiniquadError("disposed", "Application disposed during startup"));
            state = "disposed";
            cleanup();
        }
    };
    if (signal?.aborted) {
        abort();
    } else {
        signal?.addEventListener("abort", abort, { once: true });
        frame.addEventListener("load", start);
        frame.addEventListener("error", frameError);
        frame.src = runtime;
        container.append(frame);
    }
    return handle;
}
