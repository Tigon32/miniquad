# Isolated wgpu WebGPU proof

**Writing review state:** STE-aligned draft. Full dictionary review not done.

Candidate B implements [proof contract v1](../../docs/webgpu-proof-contract.md).
It uses browser WebGPU through `wgpu`. It does not implement `RenderingBackend`.
It does not change Miniquad core, ABI v3, defaults, or the core MSRV.
There is no WebGL fallback.

## Tools and dependencies

This directory is a separate Cargo workspace. Its toolchain pin is Rust 1.99.1.
The lockfile is part of the proof.

| Dependency | Version | Purpose |
| --- | --- | --- |
| `wgpu` | 30.0.1 | WebGPU resources, commands, errors, and buffer mapping |
| `wasm-bindgen` and its CLI | 0.2.130 | Generated Rust/JavaScript bindings |
| `wasm-bindgen-futures` | 0.4.80 | Browser futures |
| `js-sys`, `web-sys` | 0.3.107 | Status objects, canvas, and input events |

`wgpu` has only the `std`, `wgsl`, and `webgpu` features. Default features are off.
The JavaScript host uses the generated public `init` and `ProofApp` exports.
Do not edit generated files.

## Build and test

Run these commands from this directory. Use a rustup-managed Cargo with the
`wasm32-unknown-unknown` target and the exact CLI version above.

```sh
cargo test --lib
node build.mjs
```

Set `CARGO` or `WASM_BINDGEN` if those tools are not on `PATH`.
The build checks the generator version. It writes ignored output to `dist/`.

From the repository root, use the repository-pinned Playwright:

```sh
node --test tests/webgpu-proof/*.test.mjs
node tests/webgpu-proof/run-proof.mjs --candidate wgpu --lane software --port 4295
```

The common runner owns its server and browser. It closes both when it finishes.
The receipt is `target/webgpu-proof/wgpu-software-chromium.json`.
The software lane needs a fallback adapter. It does not prove hardware support.

## Interface and ownership

The generated binding code owns its memory-transfer rules. No hand-written
pointer/length ABI crosses this boundary. Strings use generated UTF-8 conversion.
Rust limits error messages to 4096 UTF-8 bytes at character boundaries.
JavaScript strings and status objects transfer by value through the bindings.

`ProofApp(mode, canvas)` accepts `render` or `invalid-wgsl`.
`status()` returns a fresh object. `requestReadback()` returns a positive request
id while running, or zero otherwise. `tick()` submits at most one frame.
`reportHostError(message)` forwards a host failure to Rust.
`dispose()` removes listeners and destroys the device. It is idempotent.
The host owns `requestAnimationFrame` and stops on a terminal phase.

Rust owns phases, input, GPU objects, and all post-load error codes.
Device callbacks send events through a channel; they do not cast `Rc` to `Send`.
Shader and pipeline creation use validation error scopes.
Disposal and failure also release a device held during asynchronous startup.
Startup checks for cancellation after awaits.

Readback copies the rendered texture before submission in the same encoder.
Rows have 256-byte alignment. Rust reads the mapped bytes, converts BGRA to RGBA,
then unmaps and destroys the buffer. A stale or terminal callback releases its
buffer without changing status.

## Evidence and limits

On macOS arm64, Chromium 158.0.8127.18 with Playwright 1.65.0 and SwiftShader:
T1–T6 passed. T7 and N1–N5 passed as rejection cases. The adapter reported
`isFallbackAdapter: true`. Exact center and corner pixels passed before and after
resize. No WebGL context was requested.

Five host Rust unit tests check UTF-8 limits, terminal disposal,
request-id exhaustion, pixel-ratio arithmetic, and texture/readback bounds.
The common harness passed 18 unit tests.

The later [shared hardware observations](../../tests/webgpu-proof/README.md#recorded-hardware-observations)
ran both candidates from clean source `ec68f04c833163f7cd5bffb7dbad5c557a3cf198`.
Both headful runs of this candidate passed all 12 cases on a non-fallback Apple adapter.
The result is **OBSERVED, NOT QUALIFIED**.

Native rendering, Linux WebGPU, Windows, Firefox WebGPU, and WebKit WebGPU are **NOT TESTED**
for this candidate. This proof does not qualify a production backend or release.
No performance comparison is claimed.
