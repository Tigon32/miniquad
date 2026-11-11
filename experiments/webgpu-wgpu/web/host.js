const contract = "miniquad-webgpu-proof/1";
const candidate = "wgpu";
const requestedMode = new URL(location.href).searchParams.get("mode") ?? "render";
const validMode = ["render", "invalid-wgsl"].includes(requestedMode);
const terminal = new Set(["failed", "lost", "disposed"]);
let app;
let frame;
let cancelled = false;
const loading = {
    contract, candidate, reporter: "host", mode: validMode ? requestedMode : "render",
    phase: "loading", error: null, canvasFormat: null,
    surface: {width: 0, height: 0}, frameCount: 0, resizeCount: 0,
    input: {pointer: null, key: null, focused: false, focusChanges: 0},
    readback: {id: 0, state: "idle", width: 0, height: 0, center: null, corner: null, error: null},
};

function message(error) {
    const text = error instanceof Error ? error.message : String(error);
    let result = "";
    let length = 0;
    for (const character of text || "Unknown startup error") {
        const size = new TextEncoder().encode(character).byteLength;
        if (length + size > 4096) break;
        result += character;
        length += size;
    }
    return result;
}

function failLoading(code, error) {
    if (terminal.has(loading.phase)) return;
    loading.phase = "failed";
    loading.error = {code, message: message(error)};
}

globalThis.__mqWebGpuProof = {
    contract,
    candidate,
    status() { return app ? app.status() : structuredClone(loading); },
    requestReadback() { return app ? app.requestReadback() : 0; },
    dispose() {
        cancelAnimationFrame(frame);
        if (app) app.dispose();
        else cancelled = true;
    },
};

function tick() {
    try {
        app.tick();
    } catch (error) {
        app.reportHostError(message(error));
    }
    if (!terminal.has(app.status().phase)) frame = requestAnimationFrame(tick);
}

async function start() {
    if (!validMode) {
        failLoading("contract-mismatch", `Unknown mode: ${requestedMode}`);
        return;
    }
    let module;
    try {
        module = await import("./pkg/webgpu_wgpu_proof.js");
        await module.default();
    } catch (error) {
        failLoading("wasm-load-failed", error);
        return;
    }
    if (terminal.has(loading.phase)) return;
    const canvas = document.getElementById("mq-proof-canvas");
    if (!(canvas instanceof HTMLCanvasElement) || typeof module.ProofApp !== "function") {
        failLoading("contract-mismatch", "Missing canvas or ProofApp export");
        return;
    }
    app = new module.ProofApp(requestedMode, canvas);
    if (cancelled) {
        app.dispose();
        return;
    }
    frame = requestAnimationFrame(tick);
}

await start();
