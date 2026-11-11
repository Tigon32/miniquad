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
- Playwright: `1.56.1`, from the sibling `miniquad` worktree's
  `node_modules` (see "Playwright access" below).
- Browser (software lane): Chromium `141.0.7390.37`, flags
  `--enable-unsafe-webgpu --enable-unsafe-swiftshader
  --use-angle=swiftshader`.
- Adapter facts recorded by the harness: `vendor: "google"`,
  `architecture: "swiftshader"`, `isFallbackAdapter: true` — confirms the
  software (SwiftShader) path, not real GPU hardware.
- OS: macOS (darwin 25.6.0, arm64). **Hardware/native: NOT TESTED.**

### Playwright access

This worktree has no `node_modules` of its own. Node's ESM resolver does
not honor `NODE_PATH` for `import` statements, so a transient, untracked
symlink `node_modules -> ../../miniquad/node_modules` (the root worktree
the user approved) was used locally to resolve `@playwright/test` while
running the harness. This symlink is not part of the candidate and is not
committed.

## Commands run and results

```sh
~/.cargo/bin/cargo test --lib
# test result: ok. 44 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

node --check web/host.js
# ok

CARGO=~/.cargo/bin/cargo node build.mjs --release
# Built release into .../experiments/webgpu-manual/dist
# dist/app.wasm: 61078 bytes (release; the earlier debug artifact was
# ~2.4 MB and is not a size basis for comparison)

node tests/webgpu-proof/run-proof.mjs --candidate manual --lane software   # (repo root)
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
```

All of T1-T7 (render path) and N1-N5 (rejection path) pass on the real
software lane (SwiftShader, Chromium, Playwright) against the **release**
build. This is a single local run, not a substitute for the eventual
common CI harness run. Hardware (a real, non-fallback GPU adapter) and
native platforms were **not tested**.

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
   `{reporter: "host", code: "internal"}` on any post-load failure. The
   last Rust-reported status is now cached (`lastRustStatus`) and served
   by `status()` on a read failure instead; `start().catch()` only
   fabricates `wasm-load-failed` when `wasm` never got assigned, and
   otherwise only logs (`status()` keeps serving Rust's last report).
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

Rust unit tests: 44/44 (43 prior plus the new disposal-race test). The
shared harness and shared shaders were not edited; no oracle was
weakened.

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
