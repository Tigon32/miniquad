// A host-level (JavaScript) regression test for `web/host.js`'s frame
// loop. A queen review found that the loop's `step()` swallowed a
// `readStatus()` failure with a bare `catch { return; }`: it stopped the
// loop silently without ever reporting the failure to Rust. That is a
// success-shaped silent failure (the last real status could still look
// like "running"), forbidden by the contract and by project rules even
// where the frozen v1 oracle happens not to cover it.
//
// The fix routes that failure through the same `reportHostError` ingress
// `status()` already uses (contract section 5: only "wasm-load-failed"
// and "contract-mismatch" may use reporter "host"). This test drives
// `web/host.js` against a small fake WASM module (see
// `host-test-fixture.mjs`), forces one `mq_proof_status` failure inside
// the queued animation-frame callback, and asserts the host-error
// ingress ran exactly once. It is local to this candidate; it does not
// change `tests/webgpu-proof/**` (the shared harness/oracle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installBrowserStubs, makeFakeWasm } from "./host-test-fixture.mjs";

test("the frame loop routes a status-read failure into Rust instead of silently stopping", async () => {
    const fake = makeFakeWasm();
    const stubs = installBrowserStubs(fake.exports);

    await import("../web/host.js");
    const api = globalThis.__mqWebGpuProof;
    assert.ok(api, "host.js must publish __mqWebGpuProof");

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.status().phase, "running");
    assert.equal(stubs.queuedFrameCount(), 1, "startFrameLoop() must queue exactly one initial frame");

    // Force the next `mq_proof_status()` call (made by the frame loop's
    // own `readStatus()`) to throw, simulating an unexpected host bug
    // while the loop is running.
    fake.failNextStatusRead();
    stubs.runQueuedFrame();

    assert.equal(fake.hostErrorCallCount(), 1, "the host-error ingress must be called exactly once");
    const after = api.status();
    assert.equal(after.phase, "failed", "the failure must become a real Rust-reported terminal phase");
    assert.equal(after.reporter, "rust");
    assert.equal(after.error.code, "internal");
    assert.equal(
        stubs.queuedFrameCount(),
        0,
        "the loop must not re-queue a frame after an unhandled status-read failure"
    );
});
