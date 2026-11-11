// Shared stub fixture for the host-level (JavaScript) regression tests
// of `web/host.js`. It drives the host against a small fake "Rust" WASM
// module (not the real crate) so these tests can force exact failures
// without a browser or a real GPU. This file is local to this candidate;
// it does not change `tests/webgpu-proof/**` (the shared harness/oracle).
//
// `web/host.js` has no module exports; it executes on import and
// publishes itself as `globalThis.__mqWebGpuProof`. To reach its
// otherwise-private `imports.mq_webgpu_proof` object (the `js_request_*`
// functions Rust would call), the `WebAssembly.instantiate` stub below
// captures the real `imports` argument host.js passes it.

export function makeFakeWasm() {
    const memory = new WebAssembly.Memory({ initial: 4 });
    let heapTop = 16;
    const alloc = len => {
        const ptr = heapTop;
        heapTop += len;
        return ptr;
    };

    let phase = "loading";
    let errorCode = null;
    let errorMessage = "";
    let hostErrorCalls = 0;
    let failNextStatusRead = false;
    const adapterResults = [];
    const deviceResults = [];

    const statusJson = () =>
        JSON.stringify({
            contract: "miniquad-webgpu-proof/1",
            candidate: "manual",
            reporter: "rust",
            mode: "render",
            phase,
            error: errorCode ? { code: errorCode, message: errorMessage } : null,
            canvasFormat: null,
            surface: { width: 0, height: 0 },
            frameCount: 0,
            resizeCount: 0,
            input: { pointer: null, key: null, focused: false, focusChanges: 0 },
            readback: { id: 0, state: "idle", width: 0, height: 0, center: null, corner: null, error: null },
        });

    const exports = {
        memory,
        mq_proof_alloc: len => alloc(len),
        mq_proof_free: () => {},
        mq_proof_init: () => {
            phase = "running";
            return 1;
        },
        mq_proof_status: outPtr => {
            if (failNextStatusRead) {
                failNextStatusRead = false;
                throw new Error("simulated status read failure");
            }
            const bytes = new TextEncoder().encode(statusJson());
            const ptr = alloc(bytes.length);
            new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
            const view = new DataView(memory.buffer, outPtr, 8);
            view.setUint32(0, ptr, true);
            view.setUint32(4, bytes.length, true);
        },
        // Decodes with Buffer, not the (test-patched) global TextDecoder,
        // so this fake "Rust" side keeps working while a test forces the
        // host's own `readStatus()` decode to fail once.
        mq_proof_host_error: (ptr, len) => {
            hostErrorCalls += 1;
            const bytes = new Uint8Array(memory.buffer, ptr, len);
            errorMessage = Buffer.from(bytes).toString("utf8");
            phase = "failed";
            errorCode = "internal";
        },
        mq_proof_request_readback: () => 0,
        mq_proof_dispose: () => 1,
        mq_proof_tick: () => {},
        mq_proof_pointer_event: () => {},
        mq_proof_key_event: () => {},
        mq_proof_focus_event: () => {},
        mq_proof_resize: () => {},
        mq_proof_adapter_result: (requestId, ok, handle) => {
            adapterResults.push({ requestId, ok, handle });
        },
        mq_proof_device_result: (requestId, ok, handle) => {
            deviceResults.push({ requestId, ok, handle });
        },
        mq_proof_device_lost: () => {},
    };
    return {
        exports,
        hostErrorCallCount: () => hostErrorCalls,
        failNextStatusRead: () => {
            failNextStatusRead = true;
        },
        lastAdapterResult: () => adapterResults.at(-1),
        lastDeviceResult: () => deviceResults.at(-1),
    };
}

// Installs browser stubs and returns hooks for test-only access to things
// `web/host.js` otherwise keeps file-private: `getImports()` returns the
// `mq_webgpu_proof` import object once `WebAssembly.instantiate` has been
// called, and `runQueuedFrame()` invokes the next queued
// `requestAnimationFrame` callback synchronously (there is no real
// browser frame clock in this test).
export function installBrowserStubs(fakeExports, { gpu } = {}) {
    const rafQueue = [];
    const canvas = {
        width: 0,
        height: 0,
        clientWidth: 256,
        clientHeight: 256,
        addEventListener: () => {},
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const requestAnimationFrame = fn => {
        rafQueue.push(fn);
        return rafQueue.length;
    };
    globalThis.window = {
        location: { href: "http://localhost/index.html?mode=render" },
        isSecureContext: true,
        devicePixelRatio: 1,
        addEventListener: () => {},
        requestAnimationFrame,
    };
    globalThis.requestAnimationFrame = requestAnimationFrame;
    globalThis.document = {
        getElementById: id => (id === "mq-proof-canvas" ? canvas : null),
    };
    Object.defineProperty(globalThis, "navigator", {
        value: { gpu: gpu || {} },
        configurable: true,
    });
    globalThis.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
    });
    let capturedImports = null;
    globalThis.WebAssembly = {
        ...WebAssembly,
        instantiate: async (_bytes, imports) => {
            capturedImports = imports;
            return { instance: { exports: fakeExports } };
        },
    };
    return {
        getImports: () => capturedImports,
        runQueuedFrame: () => {
            const next = rafQueue.shift();
            if (next) next();
        },
        queuedFrameCount: () => rafQueue.length,
    };
}
