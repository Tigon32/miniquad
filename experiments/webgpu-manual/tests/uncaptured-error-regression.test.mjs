// A host-level (JavaScript) regression test for `web/host.js`'s GPU
// device wiring. A queen review found that `requestDevice()` never
// listened for `GPUDevice`'s `uncapturederror` event: a validation error
// that does not go through any of the request/response flows above
// (adapter/device/context/shader/pipeline/frame) would vanish silently
// instead of becoming a real Rust-reported failure, and the contract and
// project rules forbid that kind of success-shaped silent failure
// (candidate B already routes this; no WebGL fallback or hidden retry is
// allowed either).
//
// The fix adds a `device.addEventListener("uncapturederror", ...)`
// listener that reuses the existing `reportHostError` ingress. This test
// drives `web/host.js` against a small fake WASM module and a fake
// `navigator.gpu`/adapter/device chain (see `host-test-fixture.mjs`), so
// it can dispatch a synthetic `uncapturederror` event without a browser
// or a real GPU. It is local to this candidate; it does not change
// `tests/webgpu-proof/**` (the shared harness/oracle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installBrowserStubs, makeFakeWasm } from "./host-test-fixture.mjs";

test("an uncapturederror event on the GPU device is routed into Rust, not silently dropped", async () => {
    const fake = makeFakeWasm();

    let capturedErrorHandler = null;
    const fakeDevice = {
        destroy() {},
        lost: new Promise(() => {}), // never resolves; this test is not about device loss
        addEventListener(name, handler) {
            if (name === "uncapturederror") capturedErrorHandler = handler;
        },
    };
    const fakeAdapter = {
        requestDevice: async () => fakeDevice,
    };
    const gpu = { requestAdapter: async () => fakeAdapter };

    const stubs = installBrowserStubs(fake.exports, { gpu });

    await import("../web/host.js");
    const api = globalThis.__mqWebGpuProof;
    assert.ok(api, "host.js must publish __mqWebGpuProof");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.status().phase, "running");

    const imports = stubs.getImports();
    assert.ok(imports, "WebAssembly.instantiate must receive the mq_webgpu_proof import object");

    // Drive the same adapter -> device request sequence Rust would drive,
    // using the real `js_request_adapter`/`js_request_device` imports
    // host.js built (not reimplemented logic).
    imports.mq_webgpu_proof.js_request_adapter(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    const adapterResult = fake.lastAdapterResult();
    assert.equal(adapterResult.ok, 1, "the fake adapter must resolve successfully");

    imports.mq_webgpu_proof.js_request_device(2, adapterResult.handle);
    await new Promise(resolve => setTimeout(resolve, 0));
    const deviceResult = fake.lastDeviceResult();
    assert.equal(deviceResult.ok, 1, "the fake device must resolve successfully");
    assert.ok(capturedErrorHandler, "requestDevice() must register an uncapturederror listener");

    // Dispatch a synthetic uncaptured GPU validation error, as a real
    // browser would when a validation error occurs outside the
    // request/response flows above.
    capturedErrorHandler({ error: new Error("simulated GPU validation error") });

    assert.equal(fake.hostErrorCallCount(), 1, "the host-error ingress must be called exactly once");
    const after = api.status();
    assert.equal(after.phase, "failed", "an uncaptured GPU error must become a real Rust-reported terminal phase");
    assert.equal(after.reporter, "rust");
    assert.equal(after.error.code, "internal");
    assert.match(after.error.message, /simulated GPU validation error/);
});
