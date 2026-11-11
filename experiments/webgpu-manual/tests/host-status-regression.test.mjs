// A host-level (JavaScript) regression test for `web/host.js`'s
// `status()`/`start().catch()` must-fix: contract section 5 allows
// reporter "host" only for "wasm-load-failed" and "contract-mismatch".
// A prior fix attempt served a cached last-good status on a read failure;
// that is forbidden because a cache can still have a running/success
// shape, silently hiding a real new failure. The accepted fix instead
// routes an unexpected post-load error through a new `mq_proof_host_error`
// export into a real Rust-reported "internal" failure, then re-reads the
// real status.
//
// This test drives `web/host.js` against a small fake WASM module (not
// the real Rust crate) so it can force a status-read failure without a
// browser or a real GPU. It is local to this candidate; it does not
// change `tests/webgpu-proof/**` (the shared harness/oracle).
import assert from "node:assert/strict";
import { test } from "node:test";

function makeFakeWasm() {
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
            const bytes = new TextEncoder().encode(statusJson());
            const ptr = alloc(bytes.length);
            new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
            const view = new DataView(memory.buffer, outPtr, 8);
            view.setUint32(0, ptr, true);
            view.setUint32(4, bytes.length, true);
        },
        // Decodes with Buffer, not the (test-patched) global TextDecoder,
        // so this fake "Rust" side keeps working while the test forces
        // the host's own `readStatus()` decode to fail once.
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
    };
    return { exports, hostErrorCallCount: () => hostErrorCalls };
}

function installBrowserStubs(fakeExports) {
    const listeners = new Map();
    const canvas = {
        width: 0,
        height: 0,
        clientWidth: 256,
        clientHeight: 256,
        addEventListener: () => {},
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    globalThis.window = {
        location: { href: "http://localhost/index.html?mode=render" },
        isSecureContext: true,
        devicePixelRatio: 1,
        addEventListener: (name, fn) => listeners.set(name, fn),
        requestAnimationFrame: () => 0,
    };
    globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
    globalThis.document = {
        getElementById: id => (id === "mq-proof-canvas" ? canvas : null),
    };
    Object.defineProperty(globalThis, "navigator", { value: { gpu: {} }, configurable: true });
    globalThis.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
    });
    globalThis.WebAssembly = {
        ...WebAssembly,
        instantiate: async () => ({ instance: { exports: fakeExports } }),
    };
}

test("status() routes an unexpected read failure into Rust instead of serving a cached status", async () => {
    const fake = makeFakeWasm();
    installBrowserStubs(fake.exports);

    const host = (await import("../web/host.js")).default ?? globalThis.__mqWebGpuProof;
    // `host.js` has no module exports; it publishes itself on `globalThis`.
    const api = globalThis.__mqWebGpuProof;
    assert.ok(api, "host.js must publish __mqWebGpuProof");

    // Let `start()`'s two awaited steps (fetch, WebAssembly.instantiate)
    // resolve before reading status.
    await new Promise(resolve => setTimeout(resolve, 20));

    const running = api.status();
    assert.equal(running.phase, "running");
    assert.equal(running.error, null);

    // Force exactly one `readStatus()` decode failure, simulating an
    // unexpected post-load host bug (contract section 5 forbids treating
    // this as a reportable "host" status).
    const RealTextDecoder = globalThis.TextDecoder;
    let decodeCalls = 0;
    class FlakyTextDecoder extends RealTextDecoder {
        decode(...args) {
            decodeCalls += 1;
            if (decodeCalls === 1) throw new Error("simulated decode failure");
            return super.decode(...args);
        }
    }
    globalThis.TextDecoder = FlakyTextDecoder;

    let afterFailure;
    try {
        afterFailure = api.status();
    } finally {
        globalThis.TextDecoder = RealTextDecoder;
    }

    // The must-fix requirement: route into Rust, then read the real
    // (now-failed) status. A cache-fallback fix would have returned the
    // untouched "running" status instead.
    assert.equal(fake.hostErrorCallCount(), 1, "the host-error ingress must be called exactly once");
    assert.equal(decodeCalls, 2, "status() must re-read the real status after reporting the error");
    assert.equal(afterFailure.phase, "failed");
    assert.equal(afterFailure.reporter, "rust");
    assert.equal(afterFailure.error.code, "internal");
    assert.notEqual(
        afterFailure.phase,
        running.phase,
        "a cached running/success status must never be served for a new unexpected failure"
    );
});
