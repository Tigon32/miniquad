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
// This test drives `web/host.js` against a small fake WASM module (see
// `host-test-fixture.mjs`), not the real Rust crate, so it can force a
// status-read failure without a browser or a real GPU. It is local to
// this candidate; it does not change `tests/webgpu-proof/**` (the shared
// harness/oracle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installBrowserStubs, makeFakeWasm } from "./host-test-fixture.mjs";

test("status() routes an unexpected read failure into Rust instead of serving a cached status", async () => {
    const fake = makeFakeWasm();
    installBrowserStubs(fake.exports);

    // `host.js` has no module exports; it publishes itself on `globalThis`.
    await import("../web/host.js");
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
