// Host adapter for the manual WebGPU proof candidate
// (docs/webgpu-proof-contract.md, version miniquad-webgpu-proof/1).
//
// This file implements the `mq_webgpu_proof` import module that
// `src/bridge.rs` calls, and it calls the `mq_proof_*` exports documented
// in `README.md`. Rust owns the application state; this file reports
// facts to Rust and does not hold its own copy of the state.

const CONTRACT = "miniquad-webgpu-proof/1";
const CANDIDATE = "manual";
const MAX_MESSAGE_BYTES = 4096;

const params = new URL(window.location.href).searchParams;
const mode = params.get("mode") || "render";

const canvas = document.getElementById("mq-proof-canvas");

// -- Host-reported status before the WASM module is ready, and the
// terminal fallback if the module never loads. Contract section 5: only
// "wasm-load-failed" and "contract-mismatch" may have reporter "host".
function hostStatus(phase, error) {
    return {
        contract: CONTRACT,
        candidate: CANDIDATE,
        reporter: "host",
        mode,
        phase,
        error: error || null,
        canvasFormat: null,
        surface: {width: 0, height: 0},
        frameCount: 0,
        resizeCount: 0,
        input: {pointer: null, key: null, focused: false, focusChanges: 0},
        readback: {id: 0, state: "idle", width: 0, height: 0, center: null, corner: null, error: null},
    };
}

let fallbackStatus = hostStatus("loading", null);
let wasm = null; // {exports, memory}
let statusOutPtr = 0;
let disposed = false;

// Canvas format code <-> string (src/pixel.rs::CanvasFormat::from_code).
const FORMAT_CODES = {bgra8unorm: 0, rgba8unorm: 1};

// GPU object handle table. Handle 0 means none (contract section 7).
let nextHandle = 1;
const handles = new Map();
function putHandle(value) {
    const handle = nextHandle;
    nextHandle += 1;
    handles.set(handle, value);
    return handle;
}
function getHandle(handle) {
    return handles.get(handle) || null;
}

let adapter = null;
let device = null;
let context = null;
let pipeline = null;
let canvasFormat = null;

// -- Memory helpers -------------------------------------------------------

// Rust calls `bridge::*` (which calls these import functions) from inside
// a `with_state` closure that holds a `RefCell` borrow of the state. A
// synchronous call back into a `mq_proof_*` export from here would nest a
// second borrow of that same `RefCell` and panic. `requestContext`,
// `createPipeline`, and `renderFrame` have outcomes the WebGPU API
// resolves synchronously, so their result calls go through this helper to
// move them to a microtask, after the triggering export call has
// returned and the outer borrow is released.
function deferToRust(callExport) {
    queueMicrotask(callExport);
}

function memoryBuffer() {
    // Contract section 7, "Memory growth": get `memory.buffer` again after
    // each call into Rust; never keep an old typed-array view.
    return wasm.exports.memory.buffer;
}

// Writes `bytes` into a fresh Rust-owned buffer and returns its pointer.
// For `bytes.byteLength === 0` this returns 0 and does not allocate
// (contract section 7).
function allocBytes(bytes) {
    const len = bytes.byteLength;
    if (len === 0) return 0;
    const ptr = wasm.exports.mq_proof_alloc(len) >>> 0;
    if (ptr === 0) return 0;
    new Uint8Array(memoryBuffer(), ptr, len).set(bytes);
    return ptr;
}

function allocText(text) {
    const encoded = new TextEncoder().encode(text);
    const bytes = encoded.byteLength > MAX_MESSAGE_BYTES ? cutToByteLimit(encoded, MAX_MESSAGE_BYTES) : encoded;
    const ptr = allocBytes(bytes);
    return {ptr, len: bytes.byteLength};
}

// Cuts `bytes` to at most `limit` bytes at a UTF-8 character boundary.
function cutToByteLimit(bytes, limit) {
    let end = limit;
    // A UTF-8 continuation byte has the top two bits `10`; back off until
    // `end` is not in the middle of a multi-byte character.
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end);
}

function readStatus() {
    wasm.exports.mq_proof_status(statusOutPtr);
    const header = new DataView(memoryBuffer(), statusOutPtr, 8);
    const ptr = header.getUint32(0, true);
    const len = header.getUint32(4, true);
    const bytes = new Uint8Array(memoryBuffer(), ptr, len);
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    return JSON.parse(text);
}

// Routes an unexpected host-side (JavaScript) error into Rust as a real
// `internal` failure (contract section 5: only `wasm-load-failed` and
// `contract-mismatch` may have reporter "host"). This must never be
// substituted with a cached old status: a cached status can have a
// running/success shape, silently hiding a real new failure.
function reportHostError(message) {
    const {ptr, len} = allocText(message);
    wasm.exports.mq_proof_host_error(ptr, len);
}

// -- Host object (contract section 4) -------------------------------------

const host = {
    contract: CONTRACT,
    candidate: CANDIDATE,
    status() {
        if (!wasm) return fallbackStatus;
        try {
            return readStatus();
        } catch (error) {
            // A read failure here is not itself a reportable "host"
            // status (contract section 5). Route it into Rust as a real
            // "internal" failure, then read Rust's real (now-failed)
            // status; never serve a stale cached status, which could
            // still have a running/success shape.
            reportHostError(String((error && error.message) || error));
            return readStatus();
        }
    },
    requestReadback() {
        if (!wasm) return 0;
        try {
            return wasm.exports.mq_proof_request_readback() >>> 0;
        } catch {
            return 0;
        }
    },
    dispose() {
        disposed = true;
        if (!wasm) {
            fallbackStatus = hostStatus("disposed", null);
            return;
        }
        try {
            const first = wasm.exports.mq_proof_dispose() !== 0;
            if (first) releaseGpuResources();
        } catch {
            // dispose() must not throw (contract section 4).
        }
    },
};
Object.defineProperty(globalThis, "__mqWebGpuProof", {value: host, configurable: false, enumerable: true});

function releaseGpuResources() {
    if (device) {
        try {
            device.destroy();
        } catch {
            // Already lost or destroyed; nothing more to release.
        }
    }
    handles.clear();
    adapter = null;
    device = null;
    context = null;
    pipeline = null;
}

// -- Imports: Rust calls these (module `mq_webgpu_proof`) -----------------

function requestAdapter(requestId) {
    navigator.gpu.requestAdapter().then(
        result => {
            adapter = result;
            const handle = result ? putHandle(result) : 0;
            wasm.exports.mq_proof_adapter_result(requestId, result ? 1 : 0, handle);
        },
        () => wasm.exports.mq_proof_adapter_result(requestId, 0, 0),
    );
}

function requestDevice(requestId, adapterHandle) {
    const chosenAdapter = getHandle(adapterHandle);
    if (!chosenAdapter) {
        wasm.exports.mq_proof_device_result(requestId, 0, 0);
        return;
    }
    chosenAdapter.requestDevice().then(
        result => {
            device = result;
            // An "uncapturederror" is a GPU validation error that did
            // not go through requestDevice/compileShader/createPipeline/
            // render-frame above (for example, a queue submit outside
            // those flows). It must still become a real Rust-reported
            // failure (contract section 5), never vanish silently or
            // fall back to a hidden retry/WebGL.
            device.addEventListener("uncapturederror", event => {
                reportHostError(String((event.error && event.error.message) || event.error));
            });
            device.lost.then(info => {
                const reasonCode = info && info.reason === "destroyed" ? 0 : 1;
                if (wasm) wasm.exports.mq_proof_device_lost(reasonCode);
            });
            const handle = putHandle(result);
            wasm.exports.mq_proof_device_result(requestId, 1, handle);
        },
        () => wasm.exports.mq_proof_device_result(requestId, 0, 0),
    );
}

function requestContext(requestId, deviceHandle) {
    const chosenDevice = getHandle(deviceHandle);
    if (!chosenDevice) {
        deferToRust(() => wasm.exports.mq_proof_context_result(requestId, 0, 0));
        return;
    }
    const ctx = canvas.getContext("webgpu");
    if (!ctx) {
        deferToRust(() => wasm.exports.mq_proof_context_result(requestId, 0, 0));
        return;
    }
    const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device: chosenDevice,
        format: preferredFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    context = ctx;
    canvasFormat = preferredFormat;
    const code = Object.prototype.hasOwnProperty.call(FORMAT_CODES, preferredFormat)
        ? FORMAT_CODES[preferredFormat]
        : null;
    if (code === null) {
        deferToRust(() => wasm.exports.mq_proof_context_result(requestId, 0, 0));
        return;
    }
    deferToRust(() => wasm.exports.mq_proof_context_result(requestId, 1, code));
}

function compileShader(requestId, deviceHandle, codePtr, codeLen) {
    const chosenDevice = getHandle(deviceHandle);
    const code = new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(memoryBuffer(), codePtr, codeLen));
    if (!chosenDevice) {
        reportShaderResult(requestId, false, 0, "device handle is unknown");
        return;
    }
    // `createShaderModule` with invalid WGSL can also raise a device-level
    // "validation" error outside the documented `getCompilationInfo()`
    // path (that is what the device's `uncapturederror` listener exists
    // for). Scope that one call so the shader-compilation message from
    // `getCompilationInfo()` below stays the single report (contract's
    // "shader-compilation" code), instead of racing the `uncapturederror`
    // listener's "internal" code.
    chosenDevice.pushErrorScope("validation");
    const module = chosenDevice.createShaderModule({code});
    chosenDevice.popErrorScope().catch(() => {});
    module.getCompilationInfo().then(
        info => {
            const hasError = info.messages.some(m => m.type === "error");
            if (hasError) {
                const text = info.messages
                    .filter(m => m.type === "error")
                    .map(m => m.message)
                    .join("; ") || "shader compilation failed";
                reportShaderResult(requestId, false, 0, text);
                return;
            }
            const handle = putHandle(module);
            reportShaderResult(requestId, true, handle, "");
        },
        error => {
            // `getCompilationInfo()` should not reject under the contract's
            // shared shaders, but an unhandled rejection would leave the
            // state machine in "starting" forever; forward it as a
            // shader-compilation failure instead.
            reportShaderResult(requestId, false, 0, String((error && error.message) || error));
        },
    );
}

function reportShaderResult(requestId, ok, handle, message) {
    const {ptr, len} = allocText(message);
    // `js_compile_shader` is called synchronously from Rust, and the
    // "device handle is unknown" branch above reports synchronously too;
    // deferring one microtask keeps this call from nesting inside that
    // call's state borrow (see `deferToRust`).
    deferToRust(() => wasm.exports.mq_proof_shader_result(requestId, ok ? 1 : 0, handle, ptr, len));
}

function createPipeline(requestId, deviceHandle, shaderHandle) {
    const chosenDevice = getHandle(deviceHandle);
    const shaderModule = getHandle(shaderHandle);
    if (!chosenDevice || !shaderModule || !canvasFormat) {
        reportPipelineResult(requestId, false, 0, "device or shader handle is unknown");
        return;
    }
    // `createRenderPipeline` (synchronous) never throws for a validation
    // error; WebGPU reports that asynchronously. `createRenderPipelineAsync`
    // rejects on a validation error, so pipeline-creation failures reach
    // Rust instead of being lost.
    chosenDevice.createRenderPipelineAsync({
        layout: "auto",
        vertex: {module: shaderModule, entryPoint: "vs_main"},
        fragment: {module: shaderModule, entryPoint: "fs_main", targets: [{format: canvasFormat}]},
        primitive: {topology: "triangle-list"},
    }).then(
        created => {
            pipeline = created;
            const handle = putHandle(created);
            reportPipelineResult(requestId, true, handle, "");
        },
        error => {
            reportPipelineResult(requestId, false, 0, String((error && error.message) || error));
        },
    );
}

function reportPipelineResult(requestId, ok, handle, message) {
    const {ptr, len} = allocText(message);
    deferToRust(() => wasm.exports.mq_proof_pipeline_result(requestId, ok ? 1 : 0, handle, ptr, len));
}

function renderFrame(frameId, deviceHandle, pipelineHandle, doReadback, readbackId) {
    const chosenDevice = getHandle(deviceHandle);
    const chosenPipeline = getHandle(pipelineHandle);
    if (!chosenDevice || !chosenPipeline || !context) {
        deferToRust(() => wasm.exports.mq_proof_frame_submitted(frameId, 0));
        return;
    }
    let texture;
    try {
        texture = context.getCurrentTexture();
    } catch (error) {
        deferToRust(() => wasm.exports.mq_proof_frame_submitted(frameId, 0));
        return;
    }
    const encoder = chosenDevice.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: texture.createView(),
            clearValue: {r: 0, g: 0, b: 1, a: 1},
            loadOp: "clear",
            storeOp: "store",
        }],
    });
    pass.setPipeline(chosenPipeline);
    pass.draw(3);
    pass.end();

    let readback = null;
    if (doReadback) {
        readback = prepareReadbackCopy(encoder, texture, chosenDevice);
    }

    try {
        chosenDevice.queue.submit([encoder.finish()]);
    } catch (error) {
        deferToRust(() => wasm.exports.mq_proof_frame_submitted(frameId, 0));
        return;
    }
    deferToRust(() => wasm.exports.mq_proof_frame_submitted(frameId, 1));

    if (readback) finishReadback(readbackId, readback);
}

function prepareReadbackCopy(encoder, texture, chosenDevice) {
    const width = texture.width;
    const height = texture.height;
    const unpaddedBytesPerRow = width * 4;
    const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
    const buffer = chosenDevice.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
        {texture},
        {buffer, bytesPerRow, rowsPerImage: height},
        {width, height, depthOrArrayLayers: 1},
    );
    return {buffer, width, height, bytesPerRow};
}

function finishReadback(readbackId, readback) {
    const {buffer, width, height, bytesPerRow} = readback;
    const formatCode = FORMAT_CODES[canvasFormat];
    buffer.mapAsync(GPUMapMode.READ).then(
        () => {
            const mapped = new Uint8Array(buffer.getMappedRange());
            const byteLength = mapped.byteLength;
            const ptr = allocBytes(mapped);
            // `unmap()` detaches the `ArrayBuffer` behind `mapped`, so
            // `byteLength` was captured above; `mapped.byteLength` would
            // read 0 after this call.
            buffer.unmap();
            buffer.destroy();
            if (!wasm) return;
            wasm.exports.mq_proof_readback_result(
                readbackId, 1, width, height, ptr, byteLength, bytesPerRow, formatCode,
            );
        },
        () => {
            try {
                buffer.destroy();
            } catch {
                // Buffer never mapped; nothing to release.
            }
            if (wasm) wasm.exports.mq_proof_readback_result(readbackId, 0, width, height, 0, 0, bytesPerRow, formatCode);
        },
    );
}

const imports = {
    mq_webgpu_proof: {
        js_request_adapter: requestAdapter,
        js_request_device: requestDevice,
        js_request_context: requestContext,
        js_compile_shader: compileShader,
        js_create_pipeline: createPipeline,
        js_render_frame: (frameId, deviceHandle, pipelineHandle, doReadback, readbackId) =>
            renderFrame(frameId, deviceHandle, pipelineHandle, doReadback !== 0, readbackId),
    },
};

// -- Input and resize wiring ----------------------------------------------

function canvasBackingSize() {
    const ratio = window.devicePixelRatio || 1;
    return {
        width: Math.floor(canvas.clientWidth * ratio),
        height: Math.floor(canvas.clientHeight * ratio),
    };
}

function wireInputEvents() {
    canvas.addEventListener("mousedown", event => sendPointer(event, true));
    canvas.addEventListener("mouseup", event => sendPointer(event, false));
    canvas.addEventListener("keydown", event => sendKey(event, true));
    canvas.addEventListener("keyup", event => sendKey(event, false));
    canvas.addEventListener("focus", () => sendFocus(true));
    canvas.addEventListener("blur", () => sendFocus(false));

    let resizeScheduled = false;
    const onResize = () => {
        if (resizeScheduled) return;
        resizeScheduled = true;
        requestAnimationFrame(() => {
            resizeScheduled = false;
            if (!wasm || disposed) return;
            const size = canvasBackingSize();
            if (canvas.width === size.width && canvas.height === size.height) return;
            canvas.width = size.width;
            canvas.height = size.height;
            wasm.exports.mq_proof_resize(size.width, size.height);
        });
    };
    window.addEventListener("resize", onResize);
}

function sendPointer(event, down) {
    if (!wasm || disposed) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);
    wasm.exports.mq_proof_pointer_event(x, y, event.button >>> 0, down ? 1 : 0);
}

function sendKey(event, down) {
    if (!wasm || disposed) return;
    const {ptr, len} = allocText(event.code);
    wasm.exports.mq_proof_key_event(ptr, len, down ? 1 : 0);
}

function sendFocus(focused) {
    if (!wasm || disposed) return;
    wasm.exports.mq_proof_focus_event(focused ? 1 : 0);
}

// -- Frame loop -------------------------------------------------------------

function startFrameLoop() {
    const terminal = new Set(["failed", "lost", "disposed"]);
    function step() {
        if (!wasm || disposed) return;
        let status;
        try {
            status = readStatus();
        } catch (error) {
            // A status read failure here must not just silently stop the
            // loop (a success-shaped silent failure: the last status
            // could still look like "running"). Route it into Rust as a
            // real "internal" failure (contract section 5), same as
            // status()'s catch.
            reportHostError(String((error && error.message) || error));
            return;
        }
        if (terminal.has(status.phase)) return;
        wasm.exports.mq_proof_tick();
        requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// -- Startup ----------------------------------------------------------------

async function start() {
    const apiAvailable = "gpu" in navigator && Boolean(navigator.gpu);
    const secureContext = Boolean(window.isSecureContext);

    let bytes;
    try {
        const response = await fetch("app.wasm");
        if (!response.ok) throw new Error("fetch gave status " + response.status);
        bytes = await response.arrayBuffer();
    } catch (error) {
        fallbackStatus = hostStatus("failed", {
            code: "wasm-load-failed",
            message: String((error && error.message) || error),
        });
        return;
    }

    let instance;
    try {
        const result = await WebAssembly.instantiate(bytes, imports);
        instance = result.instance;
    } catch (error) {
        fallbackStatus = hostStatus("failed", {
            code: "wasm-load-failed",
            message: String((error && error.message) || error),
        });
        return;
    }

    wasm = {exports: instance.exports};
    statusOutPtr = wasm.exports.mq_proof_alloc(8) >>> 0;

    const size = canvasBackingSize();
    canvas.width = size.width;
    canvas.height = size.height;

    const {ptr, len} = allocText(mode);
    wasm.exports.mq_proof_init(ptr, len, apiAvailable ? 1 : 0, secureContext ? 1 : 0, size.width, size.height);

    wireInputEvents();
    startFrameLoop();
}

start().catch(error => {
    // `wasm` is only assigned once the module instantiates; the two
    // "wasm-load-failed" branches above already return before this point.
    if (!wasm) {
        fallbackStatus = hostStatus("failed", {
            code: "wasm-load-failed",
            message: String((error && error.message) || error),
        });
        return;
    }
    // The module loaded, so this is an unexpected host bug, not a
    // reportable "host" status (contract section 5: only
    // "wasm-load-failed" and "contract-mismatch" may have reporter
    // "host"). Route it into Rust as a real "internal" failure instead of
    // silently leaving whatever status was last in place, which could
    // still be a running/success shape.
    console.error("mq-proof-manual: unexpected error after the WASM module loaded", error);
    reportHostError(String((error && error.message) || error));
});
