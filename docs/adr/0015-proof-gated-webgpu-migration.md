# Prove the WebGPU integration before selecting its implementation

* Status: **Proposed**
* Date: 2026-11-11
* Scope: Browser graphics migration and its isolated proof implementations
* Tracking: [#154](https://github.com/Tigon32/miniquad/issues/154)
* Source: `1364b6db83c5409cd1190856fbd5b1c8d1c5e0f3`
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

The owner requested WebGPU for new browser projects.
The current browser backend uses WebGL and GLSL through `js/gl.js`.
WebGL remains supported. Its age alone does not prove a fault.
WebGPU supplies a different graphics API, resource model, and shader language.
Changing a name or using a WebGL compatibility backend does not supply WebGPU.

The current rendering API has synchronous operations.
WebGPU initialization, shader diagnostics, and buffer mapping can be asynchronous.
A backend that silently ignores these differences would not preserve the contract.
Existing Metal panics are faults to track, not a pattern to copy.

MADR numbers 0010 and 0012 through 0014 are reserved by existing work branches.
This proposal does not change an Accepted decision.
It does not approve dependencies, change the core MSRV, or change the current default.

## Decision Drivers

* Supply real WebGPU and WGSL support.
* Report unsupported startup and device loss explicitly.
* Preserve pure geometry, picking, simulation, and existing consumers.
* Compare maintenance and integration cost, not dependency count alone.
* Measure the actual consumer bundle and required build tools.
* Keep tests repeatable on software adapters without claiming hardware qualification.
* Keep public API and ABI changes explicit and versioned.

## Considered Options

| Option | Benefit | Cost or open question |
| --- | --- | --- |
| Manual JavaScript bridge and Rust adapter | Can use the current import and callback model without new Rust crates | The project owns the adapter, handle tables, validation boundaries, and browser API maintenance |
| Optional Rust `wgpu` integration | Uses a maintained graphics implementation and typed resource APIs | Needs a higher toolchain in its isolated lane, generated JavaScript integration, dependency review, and bundle measurements |
| `wgpu` WebGL compatibility backend | Can reuse WebGL-capable devices | Does not meet the WebGPU result |
| Immediate replacement of every backend | One final API could be designed at once | Removes working paths before equivalent behavior is proved |

The first two options remain candidates.
Neither option is selected from an unmeasured size estimate.
An optional `wgpu` path does not require the removal of `gl.js` for other consumers.
Its generated loader integration still needs a repeatable, versioned contract.

## Decision Outcome

**Proposed:** compare two small, isolated WebGPU integrations before selecting the production backend.
Use one equivalent Rust/WASM application and one assertion set for both.
Do not implement the complete `RenderingBackend` trait in this proof.
Do not promise compatibility by adding panic paths for unsupported methods.

The first implementation can use the current Rust toolchain and a manual bridge.
The `wgpu` experiment requires the dependency approval in MADR 0007.
Pin approved crate and generator versions together.
Keep experiment dependencies outside the root library manifest.

### Strict backend selection

The WebGPU proof must use WebGPU or report unsupported startup.
It must not create a WebGL context after a WebGPU failure.
Do not add an automatic `WebGpuThenWebGl2` selection.
Any later legacy path must have an explicit selector and report its backend.

The current default remains unchanged during the proof.
Making WebGPU the new-project default requires the later parity and release gates.
Native GL and Metal paths remain unchanged in this proposal.

### First vertical proof

Each candidate must:

1. Start a compiled Rust/WASM application through an explicit WebGPU entry.
2. Await adapter and device creation before it reports a running application.
3. Draw a red WGSL triangle over a blue clear colour.
4. Read the canvas through a GPU copy and asynchronous mapping.
5. Return the expected centre and corner pixels.
6. Deliver malformed WGSL diagnostics to Rust as an error.
7. Deliver device loss to Rust and stop frame submission.
8. Test input, focus, resize, disposal, and failed initialization.
9. Report secure-context state, browser version, flags, and adapter information.
10. Prove that the strict path creates no WebGL context.

The [shared proof contract](../webgpu-proof-contract.md) defines the host interface,
status, error codes, test cases, and file owners for both candidates.
Use the same viewport, shader, output, and flags for both candidates.
Record raw, gzip, and Brotli bytes for the built consumer WASM and JavaScript.
Record generated files, build steps, loader changes, and project-owned adapter code.
Record startup samples and their spread only under equal conditions.
If noise prevents a comparison, report **inconclusive**.

### Selection gate

Reject a candidate that loses an error, returns success before required setup completes,
uses WebGL under a WebGPU label, or cannot reproduce the required output.

Prefer the maintained `wgpu` integration if its isolated toolchain, generated loader,
and measured consumer footprint fit the recorded deployment requirements.
Select the manual bridge only with evidence for its integration advantage and
an explicit maintenance responsibility.
Do not invent a numeric size or timing budget to select a preferred result.
Use the applicable release budgets and document any proposed change separately.

If dependency approval is not available, record the comparison as incomplete.
A manual proof alone does not establish that it is the better production option.

### Contract gate before feature parity

Write the versioned production contract before adapting quad or offscreen rendering:

* Fallible and asynchronous startup, shader, pipeline, and texture operations.
* Readback requests with pending, ready, and failed states.
* Uniform alignment, offsets, and separate values for separate draws.
* Ordered buffer updates between draws, including the staging policy.
* Unsupported formats, including `RGB8`, with no silent conversion or success.
* Depth range, projection conventions, multisampling, mipmaps, and render targets.
* Public `Backend`, `ShaderSource`, `ShaderError`, and `RawId` changes.
* The exact browser ABI and generated-loader compatibility policy.

Do not change ABI v3 merely to name the experiment.
If the production design changes the ABI, give the new ABI its own exact imports,
exports, ownership rules, and mismatch tests.
Breaking Rust enum changes require the release decision tracked by #19.

## Observed Evidence

On 2026-11-11, a standalone JavaScript probe ran on macOS arm64 with
Node `v26.10.0` and Playwright `1.56.1`:

| Browser and mode | Observed result |
| --- | --- |
| Chromium `141.0.7390.37`, default headless | `navigator.gpu` exists, but `requestAdapter()` returns null |
| Same Chromium with software-adapter flags | WGSL triangle and asynchronous pixel readback pass |
| Firefox `142.0.1`, default headless | WebGPU API unavailable |
| Desktop WebKit `26.0`, default headless | WebGPU API unavailable |

The software-adapter flags were `--enable-unsafe-webgpu`,
`--enable-unsafe-swiftshader`, and `--use-angle=swiftshader`.
The adapter reported vendor `google`, architecture `swiftshader`, and
`isFallbackAdapter: true`.
Format `bgra8unorm` gave centre RGBA `[255,0,0,255]` and corner
RGBA `[0,0,255,255]`. No validation errors were observed.

The probe and JSON receipt are retained with #154's investigation artifacts.
This is not a Miniquad WebGPU backend or a hardware performance result.
The Playwright upgrade is useful maintenance, but is not a prerequisite for this proof.

## Consequences

### Positive

* Existing useful work remains available during the migration.
* The implementation choice uses equivalent tests and actual consumer builds.
* Failure behavior is part of the proof, not deferred until release.

### Negative

* Two bounded implementations require more work than a one-option prototype.
* Native and hardware browser qualification remain separate.
* Some current rendering contracts need a breaking revision.

## Confirmation

Run the probe and proof on the actual local CI image.
Record Linux software-adapter support only after that run.
Keep software-adapter evidence separate from hardware evidence.
An unavailable API can pass an explicit rejection test; it cannot pass a rendering test.
Do not make an unsupported result a skipped rendering pass.

Hardware Safari, Windows browsers, Linux GPUs, and mobile devices are **not tested**
by the macOS headless probe.
Do not remove the legacy implementation until the required parity and migration tests pass.

## References

* [WebGPU proof contract](../webgpu-proof-contract.md)
* [Supported tool and dependency policy](0007-use-supported-and-secure-toolchains.md)
* [Risk-based verification](0002-risk-based-verification-and-selective-tdd.md)
* [WebGPU](https://webgpu.org/)
* [WebGPU specification](https://www.w3.org/TR/webgpu/)
* [WGSL specification](https://www.w3.org/TR/WGSL/)
* [Implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
* [wgpu](https://github.com/gfx-rs/wgpu)
