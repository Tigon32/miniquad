# Manual WebGPU proof candidate

**Status: STE-aligned draft.** Full ASD-STE100 dictionary review not done.

This is candidate A for issue #154: an isolated, dependency-free Rust/WASM
application plus a hand-written JavaScript WebGPU bridge. It follows the
frozen contract `docs/webgpu-proof-contract.md`, version
`miniquad-webgpu-proof/1`, exactly.

This is a **bounded proof**, not a `RenderingBackend` implementation and
not a production backend. It does not change Miniquad's core API, traits,
defaults, or dependencies.

## Scope

All files under `experiments/webgpu-manual/` only. No other tree in this
repository was changed by this candidate.

## Build

One command, using a WASM-target-capable `cargo` (this environment's
`~/.cargo/bin/cargo`, a `rustup` proxy; the Homebrew `cargo` on `PATH` in
this environment does not have the `wasm32-unknown-unknown` standard
library installed):

```sh
CARGO=~/.cargo/bin/cargo node build.mjs            # debug profile
CARGO=~/.cargo/bin/cargo node build.mjs --release  # release profile
```

This builds `wasm32-unknown-unknown` and writes `dist/app.wasm`,
`dist/index.html`, and `dist/host.js`. `dist/` is for build output only
and is not committed.

## Run (shared harness)

From the repository root, after the shared harness commit is present on
this branch:

```sh
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane software
```

The harness serves `experiments/webgpu-manual/dist/` and drives the page
with Playwright.

## Toolchain and environment actually used

- Rust/Cargo: `cargo 1.99.0 (5f94df478 2026-08-27)` / `rustc 1.99.0
  (b940084d7 2026-09-28)`, invoked as `~/.cargo/bin/cargo` (a `rustup`
  proxy; target `wasm32-unknown-unknown` was already installed).
- Node: `v26.10.0`.
- Playwright: `1.65.0` (repository-pinned; see
  `docs/webgpu-proof-contract.md`'s harness receipt, cherry-picked from
  `a0fa506`), installed into this worktree's own `node_modules` with
  `npm ci --ignore-scripts --no-audit --no-fund` after the `master` merge
  changed the manifest (see "Toolchain integration" below). The receipt
  records `playwright: {pinned: "1.65.0", installed: "1.65.0",
  matchesPin: true}`.
- Browser (software lane): Chromium `158.0.8127.18`, flags
  `--enable-unsafe-webgpu --enable-unsafe-swiftshader
  --use-angle=swiftshader`.
- Adapter facts recorded by the harness: `vendor: "google"`,
  `architecture: "swiftshader"`, `isFallbackAdapter: true` — confirms the
  software (SwiftShader) path, not real GPU hardware.
- OS: macOS (darwin 25.6.0, arm64). **Hardware/native: NOT TESTED.**

## Toolchain integration (master merge + Playwright pin)

Three integration steps were taken, in this order, before the final
rebuild and harness run below:

1. Merged `master` commit `646a9ea` ("Modernize browser tools and
   propose platform support limits (#158)") into this branch as
   `060e53e`. That commit upgrades the repository's pinned
   `@playwright/test` to `1.65.0` and adds ADR 0016; it does not touch
   `experiments/webgpu-manual/**` or the frozen contract/shared shaders.
   One merge conflict, in `docs/adr/README.md` (the decision index), was
   resolved by keeping both the ADR 0015 and ADR 0016 entries.
2. Cherry-picked `a0fa506` (`0abc6a0` on this branch) — the
   Playwright-pin-receipt change to the shared harness
   (`docs/webgpu-proof-contract.md`, `tests/webgpu-proof/`): lanes now
   read the repository-pinned Playwright version instead of a hardcoded
   `1.56.1`, and a pin/installed mismatch now fails as a `toolchain`
   case. This is an editorial/harness change explicitly authorized for
   this integration step; the host contract (v1), error codes,
   `isFallbackAdapter` rule, WGSL text, and oracle are unchanged.
3. Ran `npm ci --ignore-scripts --no-audit --no-fund` in this worktree
   (its `package.json`/`package-lock.json` changed via the merge) to
   materialize real `1.65.0` `node_modules` locally, rather than reusing
   the sibling `miniquad` worktree's still-`1.56.1` symlinked
   `node_modules` from the earlier rounds. The Chromium `158` binary for
   this Playwright version was already present in the local Playwright
   browser cache; no browser download was needed.

## Commands run and results

Full command sequence for the **final** state (dispose fix +
master merge + Playwright-pin cherry-pick + fresh release rebuild +
fresh harness run), run in this order:

```sh
~/.cargo/bin/cargo test --lib
# test result: ok. 47 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

node --test tests/*.test.mjs
# tests 3; pass 3; fail 0

npm ci --ignore-scripts --no-audit --no-fund   # repo root; manifest changed by the merge
# added 82 packages

rm -rf dist && CARGO=~/.cargo/bin/cargo node build.mjs --release
# Built release into .../experiments/webgpu-manual/dist
# dist/app.wasm: 61904 bytes, freshly timestamped at build time
# (the earlier debug artifact was ~2.4 MB and is not a size basis for
# comparison; this is also a fresh rebuild, not a reused artifact, of
# the exact source at the final commit below)

node tests/webgpu-proof/run-proof.mjs --candidate manual --lane software --port 4294   # (repo root)
# T1  pass
# T2  pass
# T3  pass
# T4  pass
# T5  pass
# T6  pass
# T7  rejection-pass
# N1  rejection-pass
# N2  rejection-pass
# N3  rejection-pass
# N4  rejection-pass
# N5  rejection-pass
# Label: software adapter; hardware: NOT TESTED
# receipt: target/webgpu-proof/manual-software-chromium.json
# playwright: {pinned: "1.65.0", installed: "1.65.0", matchesPin: true}
# browser: chromium 158.0.8127.18
# summary: {pass: 6, rejection-pass: 6, fail: 0, not-run: 0, ok: true}
```

All of T1-T6 pass on the render path; T7 and N1-N5 are rejection-pass
cases (the contract's rejection path, not a rendering pass) on the real
software lane (SwiftShader, Chromium 158, Playwright 1.65.0, matching the
repository pin) against a **freshly rebuilt release** build. This is a
single local run, not a substitute for the eventual common CI harness
run. Hardware (a real, non-fallback GPU adapter) and native platforms
were **not tested**.

## Must-fix round (conditional accept)

An independent rerun of the prior commit passed, with five required
fixes before an A/B comparison:

1. **Pipeline creation is now asynchronous.** `createPipeline()` used
   `GPUDevice.createRenderPipeline()` (synchronous), which never throws
   for a validation error; WebGPU only reports that asynchronously.
   `GPUDevice.createRenderPipelineAsync()` is used instead, and its
   promise's rejection is forwarded to Rust as `pipeline-creation`
   (contract section 6). No fixture in the frozen shared shaders drives
   an actual pipeline-validation failure, so this path is covered by code
   review and by `createRenderPipelineAsync`'s success path running on
   every T1-T6 case, not by a dedicated rejection test case.
2. **`compileShader`'s "unknown device handle" branch deferred.** It
   called `reportShaderResult` synchronously, the same reentrancy risk
   already fixed for `js_request_context`/`js_create_pipeline`/
   `js_render_frame`. `reportShaderResult` now wraps its export call in
   `deferToRust` (one microtask), matching `reportPipelineResult`.
3. **`getCompilationInfo()` rejection is now handled.** The `.then(...)`
   call had no rejection handler; an unhandled rejection would leave the
   state machine stuck in "starting" forever. A `.catch(...)` now
   forwards a `shader-compilation` failure to Rust.
4. **`host.status()` and `start().catch()` no longer fabricate a
   `reporter: "host"` status after the module has loaded.** Contract
   section 5: only `wasm-load-failed` and `contract-mismatch` may have
   `reporter: "host"`. Both places used to synthesize
   `{reporter: "host", code: "internal"}` on any post-load failure. See
   "Fix 4 rework" below for the final, accepted form of this fix; an
   intermediate cached-status approach was tried first and rejected.
5. **A pending readback result arriving after `dispose()` no longer
   mutates readback state.** `on_readback_result` (`src/state.rs`) only
   checked the request id and `ReadbackPhase::Pending`, not the overall
   `Phase`; a result that arrived after `dispose()` set `phase` to
   `Disposed` could still flip `readback.phase` to `Ready`/`Failed`. An
   `if self.phase.is_terminal() { return; }` guard was added before the
   existing id/phase check. The payload (`Vec<u8>` claimed by
   `mq_proof_readback_result`) is already freed on return regardless, so
   no separate free call was needed. Covered by a new unit test,
   `a_pending_readback_result_after_disposal_does_not_mutate_terminal_state`.

Rust unit tests at this round: 44/44 (43 prior plus the new
disposal-race test). The shared harness and shared shaders were not
edited; no oracle was weakened.

## Fix 4 rework (rejected cache fallback replaced with real Rust routing)

The first version of fix 4 cached the last Rust-reported status
(`lastRustStatus`) and served it from `status()`/`start().catch()` on an
unexpected post-load failure. This was rejected: **a cached status can
have a running/success shape and silently hide a genuinely new failure**
— exactly the kind of success-shaped fallback the contract and project
rules forbid.

The accepted fix instead adds a minimal Rust-owned post-load host-error
ingress and always re-reads a real status afterward:

- A new Rust export, `mq_proof_host_error(message_ptr, message_len)`
  (`src/lib.rs`), claims and frees the message buffer (the same ownership
  pattern as every other `mq_proof_*` export) and calls
  `state.fail_internal(message)`. `ProofErrorCode::Internal` already
  existed (`src/error.rs`) but had no caller before this; it is reused
  here, not a new error code.
- `web/host.js` no longer caches anything. `status()`'s catch calls
  `reportHostError(message)` then re-reads the real status once (a
  second failure propagates instead of being re-caught).
  `start().catch()` only fabricates `wasm-load-failed` when `wasm` never
  got assigned; any other post-load startup failure now calls
  `reportHostError(...)` instead of silently logging.
- A Rust unit test,
  `fail_internal_replaces_a_running_status_with_a_real_rust_reported_failure`,
  proves `running` -> `fail_internal` -> a real `reporter: "rust"`,
  `phase: "failed"`, `code: "internal"` status.
- A host/JS-level regression test,
  `tests/host-status-regression.test.mjs` (Node's built-in test runner,
  no new dependency), drives `web/host.js` against a stubbed browser
  environment and a hand-rolled fake WASM module, forces one
  `TextDecoder.decode()` failure, and asserts the host-error ingress ran
  exactly once and the next status is a genuinely new failure, not a
  stale cached one. This test was verified to be a true regression test:
  a throwaway copy of `host.js` reproducing the old cache-fallback logic
  was built and run against the same test, and it failed as expected
  (ingress never called, stale status served), before being deleted.

Rust unit tests after this round: 45/45.

## Dispose preserves an already-terminal phase

A cross-candidate review found that `dispose()` (`src/state.rs`) set
`self.phase = Phase::Disposed` **unconditionally**. Contract section 5:
"A terminal phase never changes to another phase." `failed` and `lost`
are already terminal; disposing after a failed startup or a lost device
was silently overwriting the real terminal phase and its error with
`disposed`.

`dispose()` now only moves a still-live phase to `Disposed`; an
already-terminal phase keeps its phase and error unchanged. GPU handles
are still released on the first call in every case (`dispose()` still
returns `true` once, telling JavaScript to tear down), matching contract
section 7 ("dispose and device loss release all handles"). Two
regression tests were added: `dispose_after_failed_keeps_the_failed_phase_and_error`
and `dispose_after_lost_keeps_the_lost_phase_and_error`, each also
checking that a repeat dispose call stays a no-op.

Rust unit tests after this round: 47/47.

## Two remaining silent-success faults (frame loop and uncaptured GPU errors)

A queen review found two more tightly-coupled silent-success faults in
`web/host.js`, found only after the Rust-side cache fallback and the
dispose() fix above were already accepted. Both are the same class of
bug as the rejected fix-4 cache: a failure that should become a real
Rust-reported terminal status instead quietly left the application
looking like it was still running.

1. **The frame loop's `step()` swallowed a status-read failure.** Its
   `catch { return; }` stopped the animation-frame loop on an unexpected
   `readStatus()` failure, but never reported it: `host.status()` would
   keep serving whatever the last real status was (which could still
   look like `running`). The loop's catch now calls `reportHostError(...)`
   (the same ingress `status()` already uses) before returning, so the
   failure becomes a real Rust `internal` terminal status.
2. **`requestDevice()` never listened for `GPUDevice`'s
   `uncapturederror` event.** A GPU validation error outside the
   request/response flows above (adapter/device/context/shader/
   pipeline/frame) had nowhere to go; it would vanish silently instead of
   becoming a Rust-reported failure, and there is no WebGL fallback or
   hidden retry path to catch it either. `requestDevice()`'s success
   callback now adds a `device.addEventListener("uncapturederror", ...)`
   listener that routes the event through `reportHostError(...)`,
   matching candidate B.

Both fixes reuse the existing `reportHostError` ingress (bounded
UTF-8 message, freed after one allocation, a no-op once the phase is
already terminal via `fail_internal`'s guard) — no new Rust export or
ownership path was added.

Two new host/JS-level regression tests were added, sharing a new
`tests/host-test-fixture.mjs` stub module with the existing
`host-status-regression.test.mjs` test (which now imports the fixture
instead of repeating it inline):

- `tests/frame-loop-error-regression.test.mjs`: forces the next
  `mq_proof_status()` call to throw while the frame loop is running, by
  invoking the queued `requestAnimationFrame` callback directly (no real
  browser clock), and asserts the host-error ingress ran exactly once and
  the loop does not re-queue a frame afterward.
- `tests/uncaptured-error-regression.test.mjs`: drives the real
  `js_request_adapter`/`js_request_device` imports host.js builds (
  captured from the `WebAssembly.instantiate(bytes, imports)` call)
  against a fake adapter/device chain, dispatches a synthetic
  `uncapturederror` event, and asserts it becomes a real Rust `internal`
  failure.

Both were verified to be true regression tests: a throwaway copy of
`host.js` with each fix reverted was built, run against its matching
test, and confirmed to fail (`0 !== 1` host-error calls for the frame
loop; no listener registered for the device case) before being deleted.

Host/JS tests after this round: 3/3 (`node --test tests/*.test.mjs`).

Adding the device-wide `uncapturederror` listener first broke the real
software-lane harness: an invalid WGSL shader (T7) raises a device-level
"validation" error outside `getCompilationInfo()`, and the new listener
reported it as `internal` instead of the oracle's `shader-compilation`
code (12/12 became 11/12). `compileShader()` now wraps its
`createShaderModule` call in `pushErrorScope("validation")` /
`popErrorScope()` so that one call's validation error stays scoped to
the existing `getCompilationInfo()` path instead of racing the
listener. T7's receipt now shows the correct `shader-compilation` code
and message again (see below).

## Imports and exports (ownership)

The WASM import module is `mq_webgpu_proof` (defined in `src/bridge.rs`);
`web/host.js` implements it. The WASM exports are `mq_proof_*`
(defined in `src/lib.rs`); `web/host.js` calls them. Memory ownership
follows contract section 7:

- `mq_proof_alloc(len) -> ptr` / `mq_proof_free(ptr, len)`: Rust-owned
  buffer lifecycle for JS-to-Rust byte transfers. `alloc` returns 0 on
  failure (allocation cap, count cap, or size over 16 MiB). `free`
  releases a buffer JavaScript allocated through `mq_proof_alloc` but
  could not deliver to a callback export (e.g., its receiver cannot run).
- Any export that takes `(ptr, len)` (`mq_proof_init`,
  `mq_proof_shader_result`, `mq_proof_pipeline_result`,
  `mq_proof_readback_result`, `mq_proof_key_event`) **claims** that
  buffer exactly once through `src/alloc.rs::claim`, by exact pointer and
  length match; a second claim, an unknown pointer, or a length mismatch
  fails closed (returns an empty buffer) rather than reconstructing raw
  parts from untrusted values.
- `mq_proof_status(out_ptr)` writes an 8-byte `(ptr: u32, len: u32)`
  header at `out_ptr` pointing at a Rust-owned JSON buffer that is valid
  only until the next call into the module (contract section 7, "memory
  growth"): JavaScript must read `wasm.exports.memory.buffer` again after
  each call, never reuse an old typed-array view.
- UTF-8 text buffers (`mode`, key codes, error messages) are capped at
  4096 bytes (`src/text.rs`); a longer buffer is cut at a UTF-8 character
  boundary before allocation, never mid-codepoint.
- GPU object handles (`adapter_handle`, `device_handle`, `shader_handle`,
  `pipeline_handle`) are host-table indices JS hands to Rust as opaque
  `u32`; handle 0 always means "none". Rust never dereferences these as
  pointers.
- Request/readback/frame IDs are monotonic `u32` counters Rust issues; a
  result for a stale ID (one superseded by a newer request) is a silent
  no-op, giving once-only delivery under a real-browser race (contract
  section 6, readback rule 6).

### Imports (`mq_webgpu_proof`, JS implements, Rust calls)

| Import | Arguments | Purpose |
| --- | --- | --- |
| `js_request_adapter` | `request_id` | Requests a `GPUAdapter`; reports via `mq_proof_adapter_result`. |
| `js_request_device` | `request_id, adapter_handle` | Requests a `GPUDevice`; reports via `mq_proof_device_result`. |
| `js_request_context` | `request_id, device_handle` | Configures the canvas's `webgpu` context; reports via `mq_proof_context_result`. |
| `js_compile_shader` | `request_id, device_handle, code_ptr, code_len` | Compiles the shared WGSL text; reports via `mq_proof_shader_result`. |
| `js_create_pipeline` | `request_id, device_handle, shader_handle` | Creates the render pipeline; reports via `mq_proof_pipeline_result`. |
| `js_render_frame` | `frame_id, device_handle, pipeline_handle, do_readback, readback_id` | Submits one frame; reports via `mq_proof_frame_submitted`, and `mq_proof_readback_result` when `do_readback` is set. |

### Exports (`mq_proof_*`, Rust implements, JS calls)

| Export | Purpose |
| --- | --- |
| `mq_proof_alloc`, `mq_proof_free` | Buffer lifecycle (see ownership above). |
| `mq_proof_init` | Starts the state machine for one page load (mode text, API/secure-context facts, initial surface size). |
| `mq_proof_status` | Writes the current JSON status (contract section 5) into a Rust-owned buffer. |
| `mq_proof_request_readback` | Starts one readback; returns its new ID or 0 if not applicable. |
| `mq_proof_dispose` | Idempotent shutdown; returns non-zero only the first time. |
| `mq_proof_tick` | Advances one animation frame while running. |
| `mq_proof_adapter_result`, `mq_proof_device_result`, `mq_proof_context_result`, `mq_proof_shader_result`, `mq_proof_pipeline_result`, `mq_proof_frame_submitted`, `mq_proof_readback_result` | Async-call completions from the matching import above. |
| `mq_proof_device_lost` | Reports `GPUDevice.lost` (reason: destroyed vs. unknown). |
| `mq_proof_host_error` | Routes an unexpected post-load JavaScript/host failure into a real Rust `internal` terminal status (never a cached or host-fabricated one; see "Fix 4 rework"). |
| `mq_proof_pointer_event`, `mq_proof_key_event`, `mq_proof_focus_event` | Input facts from the canvas. |
| `mq_proof_resize` | Reports a new canvas backing size. |

All GPU failures the contract requires Rust to report (adapter/device/
context/shader/pipeline/frame/readback failures, device loss) flow
through the `*_result`/`mq_proof_device_lost` exports above and are
reported with `reporter: "rust"` in `status()`. Only `wasm-load-failed`
(the WASM module itself never loaded) and `contract-mismatch` are
reported with `reporter: "host"` directly by `web/host.js`, matching
contract section 5.

## A correctness note on reentrancy

Rust's state is a single `thread_local! { RefCell<Option<State>> }`
(`src/lib.rs`). An export (for example `mq_proof_tick`) borrows it
mutably for the duration of the call, including while it synchronously
calls into a `js_*` import. Three of the import implementations in
`web/host.js` (`js_request_context`, `js_create_pipeline`, and
`js_render_frame`'s "frame submitted"/failure paths) can complete
**synchronously** (no WebGPU promise involved) and, if they called their
matching `mq_proof_*_result` export back synchronously, that would nest a
second mutable borrow of the same `RefCell` inside the first and panic
(`already_borrowed`). This was observed as a real browser-only failure
(the Node-stub smoke test that drove early development did not call back
synchronously and did not reproduce it). `web/host.js` defers each of
those "report result" calls one microtask forward (`queueMicrotask`,
helper `deferToRust`), which always runs after the triggering export call
has returned and released its borrow, while still delivering each result
exactly once.

A second bug of the same kind was caught by the same harness run:
`GPUBuffer.unmap()` detaches the mapped `ArrayBuffer`, so reading
`mapped.byteLength` after calling `unmap()` always read `0`; the readback
byte length is now captured before `unmap()`.

## Known limits

- Software (SwiftShader) adapter path only; real GPU hardware was **not
  tested**.
- Native (non-browser) platforms were **not tested**; this candidate is
  browser/WASM-only by contract.
- This is a bounded proof for issue #154, not a `RenderingBackend`
  implementation, and is not wired into Miniquad's production backend
  selection.
- Verified with a single local run of the real software-lane harness;
  this does not replace the eventual common CI harness run.
