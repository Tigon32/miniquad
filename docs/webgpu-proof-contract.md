# WebGPU proof contract `miniquad-webgpu-proof/1`

* Status: **Frozen for the #154 proof**. This is not a production API.
* Decision: [MADR 0015](adr/0015-proof-gated-webgpu-migration.md) (**Proposed**)
* Tracking: [#154](https://github.com/Tigon32/miniquad/issues/154)
* Base source: `163db37dc63d40654918dab6386155e0259f1c4f`
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

This contract gives the two WebGPU proof candidates one host interface,
one status format, one set of test modes, and one set of expected results.
One shared harness tests both candidates. The harness has one oracle.
A candidate that needs a different oracle does not meet this contract.

To change this contract, increase the contract version and update MADR 0015.
Do not change version 1 in place after a worker starts.

## 1. Limits of the proof

* The proof does not change the root crate, `js/gl.js`, ABI v3, MSRV 1.70,
  `ShaderSource`, `Backend`, `RenderingBackend`, or any other public type.
* The proof does not implement `RenderingBackend`.
  It must not add `panic!`, `unimplemented!`, or no-op methods to look complete.
* The proof does not add a dependency to the root `Cargo.toml` or `package.json`.
* The proof does not port quad, offscreen, drawing, voxel, or 3D shaders.
* The proof never creates a WebGL context. There is no automatic fallback.
* A software-adapter pass proves the API path only.
  Hardware results are **NOT TESTED** until a hardware lane runs.
* The proof does not define the supported OS, browser, or GPU matrix.
  Production qualification depends on the platform policy in
  [#156](https://github.com/Tigon32/miniquad/issues/156) and its proposed MADR 0016.
  The proof does not promise support for old platforms.
* The `wgpu` folder uses its own current toolchain pin. The core MSRV decision is separate.
* The proof makes no memory, size-budget, or performance claim.
  The receipt records sizes and startup samples as data only.

## 2. Files and owners

Each path has one writer. Parent integration cherry-picks between trees.

| Path | Owner | Contents |
| --- | --- | --- |
| `docs/webgpu-proof-contract.md` | Queen | This contract |
| `docs/adr/0015-proof-gated-webgpu-migration.md` | Queen, then parent | Decision record |
| `experiments/webgpu-proof-shared/triangle.wgsl` | Queen | Render shader, frozen |
| `experiments/webgpu-proof-shared/invalid.wgsl` | Queen | Invalid shader, frozen |
| `experiments/webgpu-manual/**` | Manual worker (A), exclusive | Rust crate, host JS, page, build script |
| `experiments/webgpu-wgpu/**` | `wgpu` worker (B), exclusive | Rust crate, toolchain pin, generated-loader adapter, page, build script |
| `tests/webgpu-proof/**` | Queen or parent | Shared harness, instrumentation, expected values |
| `scripts/webgpu-proof-serve.mjs` | Queen or parent | Shared static server |
| `.gitignore` | Queen or parent | Lock-file and build-output rules |

A candidate worker must not edit a path outside its own folder.
If a candidate needs a contract change, it reports the need to the queen.
The shared harness is in [`tests/webgpu-proof/`](../tests/webgpu-proof/README.md).

### Candidate folder layout

Both candidates use this layout:

```text
experiments/webgpu-<candidate>/
  Cargo.toml          # standalone crate, own [workspace] table, not in root workspace
  Cargo.lock          # committed
  src/lib.rs          # Rust proof application
  web/index.html      # proof page
  web/host.js         # host adapter that installs the host object
  build.mjs           # one build command; writes dist/
  README.md           # build command, tool versions, known limits
  dist/               # build output, not committed
```

The `wgpu` candidate also has `rust-toolchain.toml`.
The build writes `dist/index.html`, `dist/host.js`, the WASM file, and any generated JavaScript.

## 3. Candidate rules

### Shared rules

* Load the shaders from `experiments/webgpu-proof-shared/` with `include_str!`.
  Do not copy or edit the shader text.
* Use the pipeline entry points `vs_main` and `fs_main`, topology `triangle-list`,
  three vertices, no vertex buffers, and no depth or stencil state.
* Clear to `{r: 0, g: 0, b: 1, a: 1}`. Use `loadOp: "clear"` and `storeOp: "store"`.
* Configure the canvas with `navigator.gpu.getPreferredCanvasFormat()`,
  `alphaMode: "opaque"`, and usage `RENDER_ATTACHMENT | COPY_SRC`.
* Rust owns the application state and the status. JavaScript reports facts to Rust.
* The host JavaScript owns one `requestAnimationFrame` loop. It calls Rust once for each frame.
  It stops the loop when the phase is `failed`, `lost`, or `disposed`.
* Rust increases `frameCount` only after a successful `queue.submit`.

### Manual candidate (A)

* Use the current stable toolchain that supports MSRV 1.70. Add no Rust dependencies.
  A path dependency on the root `miniquad` crate for public types is allowed.
  Do not call `miniquad::start`, because it starts WebGL.
* Compile a `cdylib` for `wasm32-unknown-unknown`.
* Use the WASM import module `mq_webgpu_proof`. Do not use the `env` imports of ABI v3.
* Follow the [manual memory rules](#7-manual-candidate-memory-rules).

### `wgpu` candidate (B)

* Pin `wgpu = "=30.0.1"` with `default-features = false`.
  Enable only the features for the WebGPU backend and WGSL input.
  Do not enable `webgl`. Verify the feature names in the `wgpu 30.0.1` manifest.
* Pin `wasm-bindgen` with `=` to one exact version.
  Use the `wasm-bindgen-cli` of the same exact version.
  Record both versions and the lock-file entry in `README.md`.
* Use the generated `--target web` module and its public default `init` export.
  Do not use `__wbg_get_imports` or other internal generated names.
* Pin the toolchain in `rust-toolchain.toml` to one exact stable version at or above
  the `wgpu` MSRV. This pin applies to this folder only.
* Get compilation diagnostics with `ShaderModule::get_compilation_info` and error scopes.
  Get device loss with the device-lost callback.

## 4. Page entry and host object

The harness opens `/<candidate>/index.html?mode=<mode>`.
The server maps `/<candidate>/` to `experiments/webgpu-<candidate>/dist/`.

| `mode` | Meaning |
| --- | --- |
| `render` | Default. Start, draw each frame, accept input and readback |
| `invalid-wgsl` | Start with `invalid.wgsl`. Startup must fail with `shader-compilation` |

An unknown `mode` gives phase `failed` with code `contract-mismatch`.

The page has one canvas: `<canvas id="mq-proof-canvas" tabindex="0">`.
The canvas fills the viewport with no border, margin, or scroll bars.
The backing size equals the CSS size multiplied by `devicePixelRatio`, rounded down.
The harness sets `deviceScaleFactor: 1`.

`web/host.js` is a module. Before its first `await`, it installs this object:

```ts
interface MqWebGpuProofHost {
  readonly contract: "miniquad-webgpu-proof/1";
  readonly candidate: "manual" | "wgpu";
  status(): ProofStatus;      // synchronous; returns a new object each call
  requestReadback(): number;  // id > 0; 0 if the phase is not "running"
  dispose(): void;            // idempotent
}
declare global { var __mqWebGpuProof: MqWebGpuProofHost; }
```

The host must not throw out of these methods.
It must not contain code for test injection. The harness does all injection.

## 5. Status

`status()` returns this JSON-compatible object.
After the WASM module loads, Rust produces every field.
Before that, the host produces the object with `reporter: "host"`.

```ts
interface ProofStatus {
  contract: "miniquad-webgpu-proof/1";
  candidate: "manual" | "wgpu";
  reporter: "host" | "rust";
  mode: "render" | "invalid-wgsl";
  phase: "loading" | "starting" | "running" | "failed" | "lost" | "disposed";
  error: null | { code: ErrorCode; message: string; reason?: "destroyed" | "unknown" };
  canvasFormat: null | "bgra8unorm" | "rgba8unorm";
  surface: { width: number; height: number };
  frameCount: number;
  resizeCount: number;
  input: {
    pointer: null | { x: number; y: number; button: "left" | "middle" | "right"; down: boolean };
    key: null | { code: string; down: boolean };
    focused: boolean;
    focusChanges: number;
  };
  readback: {
    id: number;
    state: "idle" | "pending" | "ready" | "failed";
    width: number;
    height: number;
    center: null | [number, number, number, number];
    corner: null | [number, number, number, number];
    error: null | { code: ErrorCode; message: string };
  };
}
```

### Phases

| Phase | Meaning |
| --- | --- |
| `loading` | The host loads the WASM module |
| `starting` | Rust waits for the adapter, device, context, shader, or pipeline |
| `running` | Setup is complete and Rust submits frames |
| `failed` | Startup failed. Terminal |
| `lost` | The device was lost after startup. Terminal |
| `disposed` | `dispose()` completed. Terminal |

Rust sets `running` only after the pipeline exists and the shader has no compilation error.
A terminal phase never changes to another phase.
After a terminal phase, `frameCount` does not increase.

### Error codes

The string codes are the oracle. The Rust enum is the same in both candidates:

```rust
pub enum ProofErrorCode {
    ApiUnavailable,          // "api-unavailable": navigator.gpu is missing
    InsecureContext,         // "insecure-context": isSecureContext is false
    AdapterUnavailable,      // "adapter-unavailable": requestAdapter() gave null
    DeviceRequestFailed,     // "device-request-failed": requestDevice() rejected
    CanvasContextUnavailable,// "canvas-context-unavailable": getContext("webgpu") gave null
    ShaderCompilation,       // "shader-compilation": WGSL diagnostics have an error
    PipelineCreation,        // "pipeline-creation": pipeline validation failed
    ReadbackFailed,          // "readback-failed": copy or mapAsync failed
    DeviceLost,              // "device-lost": the device-lost promise resolved
    NotRunning,              // "not-running": an operation needs phase "running"
    WasmLoadFailed,          // "wasm-load-failed": host only, before Rust exists
    ContractMismatch,        // "contract-mismatch": wrong mode, version, or export set
    Internal,                // "internal": a broken invariant in the proof itself
}
```

The host checks for the API and secure context, but it reports the result to Rust.
Rust sets the status. Only `wasm-load-failed` and `contract-mismatch`
can have `reporter: "host"`. All other error codes need `reporter: "rust"`.

`message` is valid UTF-8, not empty, and at most 4096 bytes.
The harness does not compare message text, because browsers give different text.

## 6. Expected results

### Geometry and pixels

* The first surface is the viewport, 256 × 256.
* `center` is the pixel at `(floor(width / 2), floor(height / 2))`.
* `corner` is the pixel at `(0, 0)`, top left.
* Both pixels are RGBA order. Rust converts `bgra8unorm` to RGBA.
* Expected `center`: `[255, 0, 0, 255]`. Expected `corner`: `[0, 0, 255, 255]`.
  The comparison is exact.

### Readback

1. `requestReadback()` returns a new id and sets `readback.state` to `pending`.
2. On the next frame, Rust renders, then copies the current canvas texture to a buffer
   in the same command encoder, before `submit`.
3. `bytesPerRow` is the row size rounded up to a multiple of 256.
4. Rust calls `mapAsync(READ)`. It does not block or poll in a loop.
5. On success, `state` is `ready`, with `width`, `height`, `center`, and `corner`.
   On failure, `state` is `failed`, with code `readback-failed`.
6. A new request replaces the old result. A late result for an old id is discarded.

### Test cases

The harness waits for status conditions with a deadline for each step.
A deadline gives a failure that includes the last status.
The harness does not use a fixed sleep.
To show that frames stopped, the harness waits for three `requestAnimationFrame` callbacks
in the page, then compares `frameCount`.

| Id | Setup | Expected result |
| --- | --- | --- |
| T1 render | `mode=render` | `running`; `frameCount` increases; readback `ready` with expected pixels at 256 × 256 |
| T2 resize | After T1, viewport 320 × 200 | `surface` 320 × 200; `resizeCount` increases; new readback has 320 × 200 and expected pixels |
| T3 input | Click canvas at (40, 30); press and release `KeyA` | `pointer` `{x: 40, y: 30, button: "left"}`; `key.code` `"KeyA"`; values come from Rust |
| T4 focus | Focus canvas, then focus `document.body` | `focused` true, then false; `focusChanges` increases by 2 or more |
| T5 dispose | `dispose()` two times | `disposed`; frames stop; later input does not change `input`; no page error |
| T6 device loss | Harness calls `destroy()` on the recorded device | `lost`; code `device-lost`; `reason` `"destroyed"`; frames stop; no recovery |
| T7 invalid WGSL | `mode=invalid-wgsl` | `failed`; code `shader-compilation`; `frameCount` 0; never `running` |
| N1 no API | Injection deletes `navigator.gpu` | `failed`; `api-unavailable` |
| N2 insecure | Injection sets `isSecureContext` to false | `failed`; `insecure-context`; no adapter request |
| N3 no adapter | Injection makes `requestAdapter()` give null | `failed`; `adapter-unavailable` |
| N4 device rejected | Injection makes `requestDevice()` reject | `failed`; `device-request-failed` |
| N5 WASM missing | Harness route gives 404 for `**/*.wasm` | `failed`; `wasm-load-failed`; `reporter` `"host"` |

All cases also check:

* No WebGL context was requested. The `getContext` record has no `webgl` or `webgl2` entry.
* After a pass in T1 to T6, the only context type is `webgpu`.
* There is no unhandled promise rejection and no uncaught error.
* T1 to T6 have no WebGPU validation error. The harness records `uncapturederror` events.
* A rejection case (T7, N1 to N5) is a **rejection pass**, not a rendering pass.

### Harness instrumentation

The harness adds one init script before the page loads. It records:

* each `HTMLCanvasElement.prototype.getContext` context type;
* each adapter and its `info` (`vendor`, `architecture`, `isFallbackAdapter`);
* each device from `GPUAdapter.prototype.requestDevice`, so that T6 can call `destroy()`;
* each `uncapturederror` event on these devices.

The injections for N1 to N4 are separate init scripts. The hosts do not know about them.
The harness gets adapter facts from this record, not from the candidate.

## 7. Manual candidate memory rules

These rules apply to the import module `mq_webgpu_proof` only.

* A pointer is a `u32` byte offset in the WASM memory. A length is a `u32` byte count.
* **Rust to JavaScript bytes.** Rust owns the bytes. They are valid only during the call.
  JavaScript copies them before it returns. It decodes text with
  `new TextDecoder("utf-8", {fatal: true})`.
* **JavaScript to Rust bytes.** JavaScript calls the export `mq_proof_alloc(len) -> ptr`.
  Rust returns a buffer with exactly `len` bytes of capacity, or 0 on failure.
  JavaScript writes the bytes, then passes `(ptr, len)` to one callback export.
  That callback takes ownership and frees the buffer with the same `len`.
  If JavaScript cannot call the callback, it calls `mq_proof_free(ptr, len)`.
  For `len == 0`, JavaScript passes `ptr == 0` and does not allocate.
* **Text.** JavaScript encodes with `TextEncoder`. It cuts a message to 4096 bytes
  at a UTF-8 character boundary. Rust checks the bytes with `str::from_utf8`.
  Invalid bytes give code `internal`.
* **Memory growth.** After each call into Rust, JavaScript gets `memory.buffer` again.
  It does not keep an old typed-array view.
* **Handles.** JavaScript keeps GPU objects in a table. A handle is a `u32` greater than 0.
  Handle 0 means none. `dispose` and device loss release all handles.
* **Asynchronous results.** Each request has a `u32` id.
  JavaScript delivers each completion one time, with the same id.
  This includes adapter, device, shader diagnostics, pipeline, readback, and device loss.
* **Readback bytes.** JavaScript copies the mapped range, with its row padding,
  into a Rust buffer. It passes `bytesPerRow`, `width`, `height`, and the format code.
  Rust removes the padding and converts the pixel order.
* **Status.** The export `mq_proof_status(ptr_out)` writes `(ptr, len)` of the UTF-8 JSON status.
  The rule for Rust-owned bytes applies.

The worker documents each import and export, with its arguments, in `README.md`.

## 8. Lanes and labels

| Lane | Browser and flags | Rule |
| --- | --- | --- |
| `software` | Repository-pinned Playwright Chromium, `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-angle=swiftshader` | Run all cases. Require `isFallbackAdapter: true`. Label the result **software adapter** |
| `chromium-default` | Same Chromium, no flags | Record the adapter. If the adapter is null, run only the natural `adapter-unavailable` rejection. If an adapter exists, run T1 to T7 and label the result with the adapter facts. This is not hardware qualification |
| `firefox-default`, `webkit-default` | Repository-pinned Playwright Firefox and WebKit | If `navigator.gpu` is missing, run only the natural `api-unavailable` rejection. Otherwise record the facts and run T1 to T7 |
| hardware | Real GPU browsers | **NOT TESTED** in this proof |

The first proof uses current tools on macOS with a software adapter.
Native and hardware results are **NOT TESTED**.
The hardware and production lanes come from the #156 platform policy, not from this contract.

The lanes use the Playwright version pinned in the root `package.json`.
The receipt records the installed Playwright and browser versions. The receipt is the authority for the version.
A result applies only to the recorded browser version, OS, and flags.
Do not combine results from different browser versions into one claim.
The earlier standalone probes are separate historical evidence: Chromium `141` on macOS passed,
and Chromium `141` on Linux failed at `mapAsync`. They are not Miniquad candidate results.

Use the controlled injections N1 to N4 for repeatable rejection tests.
Do not require that a default browser has no GPU.
Do not report a skipped rendering case as a pass.

Use one ephemeral server on `127.0.0.1`. The default ports are 4294 for manual and 4295 for `wgpu`.
The shared harness can also serve both candidates from one port.
Do not use ports 4290, 4292, 4230, or 4231.
The server sends `application/wasm` for `.wasm` files.

## 9. Receipt

The harness writes one JSON receipt for each candidate and lane in `target/webgpu-proof/`.
The receipt does not go into Git. It records:

* contract version, candidate, source SHA, and dirty state;
* OS, Node, Playwright, browser name and version, and flags;
* `isSecureContext` and the adapter facts from the instrumentation;
* the result of each case: `pass`, `rejection-pass`, `fail`, or `not-run`, with the last status;
* raw, gzip, and Brotli bytes of the built WASM and JavaScript;
* the generated files, the build command, and the tool versions;
* startup samples to `running`, with their spread, as data only.

## 10. Comparison

Compare the candidates with [MADR 0015](adr/0015-proof-gated-webgpu-migration.md).
Both candidates use this contract, the same lane, the same flags, and the same viewport.
A candidate fails if it loses an error, reports `running` too early,
creates a WebGL context, or does not give the expected pixels.
If the measurements are noisy, report the comparison as **inconclusive**.
