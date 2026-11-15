# Compare Miniquad with plain WebGL2 before a continue-or-freeze decision

* Status: **Accepted**
* Date: 2026-11-12
* Tracking: [#157](https://github.com/Tigon32/miniquad/issues/157); related [#14](https://github.com/Tigon32/miniquad/issues/14), [#19](https://github.com/Tigon32/miniquad/issues/19), [#22](https://github.com/Tigon32/miniquad/issues/22), [#29](https://github.com/Tigon32/miniquad/issues/29), [#154](https://github.com/Tigon32/miniquad/issues/154), and [#156](https://github.com/Tigon32/miniquad/issues/156)
* Source: `65bbc8f1811254ef5ab3ec0f8979620185753680`
* Scope: one browser scene and its native/WASM portability proof
* Writing review state: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

## Context and Problem Statement

Issue #157 asks whether the fork gives a browser user more value than plain
WebGL2. The current #14 profile uses a small fixture. Its timing results are
**INCONCLUSIVE**. It does not show the value of the voxelize scene.

The reference scene is in the private repository
`Tigon32/vectorvoxeldemo`. A public result must not need that repository to
build or run. The current Miniquad profile harness measures Miniquad only.
It cannot provide a fair timing comparison with plain WebGL2.

The council recommends a bounded comparison before a continue-or-freeze
decision. The target group is a hypothesis, not a confirmed user:
**developers who need one interactive graphics application from one Rust
codebase on the web and on native platforms**.
The owner has set native-plus-web portability as a required product-policy
value for this decision. This is not evidence from user research.

## Decision Drivers

* Use the same public scene data and output requirements in both arms.
* Use the same timing method for Miniquad and plain WebGL2.
* Record uncertainty and do not claim a speed gain from noisy data.
* Keep private source code out of the public fixture and receipt.
* Separate a portability value from a browser performance claim.
* Fix the policy and test method before collecting results.
* Do not treat this comparison as a release gate or an SLO.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Decide to continue now | Preserves current work | No comparative value or confirmed target user |
| Freeze the fork now | Stops further qualification cost | No comparative evidence; does not test the portability value |
| **Run a bounded public parity comparison, then decide** | Measures one scene and tests the stated portability hypothesis | Needs two implementations and a controlled measurement |

## Decision Outcome

**Accepted: continue Miniquad** for developers who need one interactive
graphics application from one Rust codebase on the web and on native
platforms. This target group remains a hypothesis, not confirmed demand.

The owner-set policy requires native-plus-web portability. This is a product
policy, not evidence from user research. The council review found gaps in the
plain WebGL2 geometry hash and the known-bad control. The comparison now
checks the submitted buffers and uses the A/B pixel comparator for the
control. The final receipt passes the required fixture, pixel, control, and
native/WASM checks.

The timing result is **INCONCLUSIVE**. It does not show a speed gain or a
regression. The receipt is provisional because it does not contain GPU time.
Continue with the support matrix in #156 and the equivalent-scene WebGPU
proof in #154. Use #14 for performance work when a valid GPU timer is
available. This decision does not qualify support or set a release limit.

The public fixture must use a fixed, documented input. It must not import or
copy code from the private reference. The reference identifies the scene and
its expected behavior only. WebGL2 is the current browser comparison path
during the WebGPU transition in MADR 0016. This comparison does not select or
qualify the future WebGPU path.

### Fixed scene

Use the voxelize scene with these fixed inputs:

* Grid: `24 × 24`; maximum level: `7`; simulated time: `t = 0`.
* View: one canvas at `640 × 400` pixels, DPR `1`, fixed camera, and fixed
  viewport.
* Layers: voxels, vector path, vector arrows, and grid on; sample points off.
* Required counts: 152 occupied cells, 686 total voxel levels, 180 path
  points, 20 arrows, and 200 vector items.

Commit one public fixture file with the exact coordinates, levels, colors,
path, arrows, projection, and draw order. The file is the canonical input;
both arms must load it. Record its SHA-256 and a public schema that defines
coordinate order, level meaning, numeric encoding, and units. Do not generate
the fixture from private code. The required counts above must be derived from
the committed file and asserted by both arms before rendering.

Both arms must also hash the canonical vertex, color, index, and instance
data they submit. Record the encoding and hashes. The hashes must match.
Use one fixed-step frame. Wall-clock time must not change the scene. The
comparison does not require pixel parity with the private Canvas 2D reference.

### Render parity

Both browser arms must use WebGL2, the same browser, hardware adapter, canvas
size, DPR, input file, projection, draw order, and alpha rules. Use the same
logical geometry and buffer update schedule. The plain WebGL2 arm must use
an ordinary, documented WebGL2 implementation; do not add special
optimizations only to make it match Miniquad. Record each arm's batching,
instancing, and buffer strategy.

Capture each browser image from an offscreen `RGBA8` framebuffer with
multisampling disabled. Read pixels after the frame with `readPixels`.
Request an sRGB drawing buffer, where supported, and set
`premultipliedAlpha: false`, `antialias: false`, and
`preserveDrawingBuffer: true` for both contexts. Record the actual context
attributes and color-space setting. Compare RGB channels; assert that alpha
is 255 for every pixel.

Run 10 same-build A/A pairs per arm before the A/B pairs. Each arm renders its
unchanged frame twice under the same settings. The pixel tolerance is the
largest per-channel difference seen in A/A plus two channel values. A pixel
differs only when any RGB channel exceeds that tolerance. The A/B check passes
only when no more than `0.1%` of pixels differ. Report the same-arm bound; a
zero bound is valid.

Run a render-only control in each arm. Keep the fixture and counts unchanged,
then replace a `32 × 32` framebuffer region with a fixed sentinel color.
The control must change at least 1024 pixels and must fail the A/B pixel
check. This checks that the comparator detects a known difference; it does
not validate the scene.

For native macOS arm64 and WASM, assert the same fixture counts and canonical
geometry hashes, and confirm that each target renders a nonempty frame.
Capture both from offscreen `RGBA8` targets at `640 × 400`, with
multisampling disabled. Record the native graphics API and all capture
settings. The fixture must define visible pixel checks for each enabled
layer, including sample points that must remain absent. Each target must
pass these checks with a per-channel tolerance of two values. Compute and
report the cross-API pixel difference, but do not use it as a pass/fail
gate: Metal and WebGL2 can rasterize and encode color differently. Do not
claim pixel parity from matching counts or hashes.

### Measurement

* Instrument the page's `requestAnimationFrame` callbacks before either arm
  loads. Use the same page setup and wrapper for each arm. The wrapper
  records callback CPU duration and frame intervals. Both arms redraw the
  full static scene on every frame. This measures callback CPU time, not
  completed GPU work.
* Use 10 same-arm timing pairs per arm, then 20 Miniquad/WebGL2 pairs.
  Reload the page for every arm-run. Use 60 warm-up frames and 300 measured
  frames per run. Set pair order before measurement with a deterministic
  shuffle seeded from the comparison source SHA; use 10 Miniquad-first and
  10 WebGL2-first pairs.
* The primary metric is the per-run median callback CPU duration. Report the
  median paired delta and a 95% bootstrap confidence interval from 10,000
  resamples. Derive and record the bootstrap seed from the comparison source
  SHA. A timing improvement is supported only when the interval is below
  zero; a regression is supported only when it is above zero. The timer
  resolution and same-arm spread must also be smaller than the measured
  effect. Otherwise report **INCONCLUSIVE**. The bootstrap interval does not
  model timer quantization. This rule does not turn timing into a decision
  gate.
* Report frame intervals, p50/p95/p99, cold startup, page asset sizes, and
  implementation effort as descriptive results. Do not select a secondary
  metric as a decision result after seeing the data.
* Record total page assets for each arm: raw, gzip, and Brotli bytes.
  Record the compression method, tool versions, source hashes, and build
  flags.
* Record implementation and build effort as elapsed time and commands. If
  implementation time was not tracked, state that. Do not estimate it. Count
  source lines with one tool and one rule for both arms.
* Record browser, browser version, OS, CPU, GPU, adapter renderer, context
  attributes, power mode, and background workload. Confirm a hardware WebGL2
  adapter with `WEBGL_debug_renderer_info` when available. If the adapter
  cannot be confirmed, label the run as software or **BLOCKED**; do not
  report it as hardware evidence.
* Report GPU time only when a valid timer query is available. Label callback
  CPU time as submission time; do not present it as GPU time.
* Build the Miniquad arm for native macOS arm64 and `wasm32-unknown-unknown`.
  Record the exact commands, toolchains, artifact hashes, and pixel metrics.

The comparison is not release qualification. It does not establish support
for every browser, device, or native platform.

### Decision rule

The target group is developers who need one interactive graphics application
from one Rust codebase on the web and native platforms. This remains a
hypothesis. The owner-set policy for this decision is that portability is
required; this is not a user-research result.

Record **continue** when the fixture, browser parity checks, and native/WASM
build, count, geometry-hash, and nonempty-frame checks pass. The performance
results inform follow-up work but do not override the required portability
policy. Record **freeze** only if the owner changes that policy in a separate
decision. If a required check fails or is blocked, keep #157 open and record
the specific evidence needed to resolve it. Do not infer demand or absence
of demand from performance measurements.

This rule is a decision method for #157. It is not a release limit, support
claim, or approved SLO.

## Consequences

### Positive

* The decision uses a public workload and a common measurement method.
* The receipt can inform #14 and the equivalent-scene work in #154.
* The public fixture does not depend on access to the private reference.

### Negative

* The two browser implementations need separate code.
* A Mac test does not qualify other platforms or reference devices.
* The target group is not confirmed by user research. The owner has set the
  portability policy for this decision.

## Confirmation

1. **Done:** commit the public fixture and schema. Verify its counts and
   input hash.
2. **Done:** verify browser pixel parity and run the render-only control
   through the A/B pixel comparator.
3. **Done:** build the Miniquad arm for native and WASM. Verify counts,
   submitted geometry hashes, layer samples, absent sample points, and
   nonempty frames.
4. **Done:** run the fixed measurement protocol at one source revision.
   Record the receipt, artifact hashes, commands, toolchains, and limits.
5. **Done:** the advisor recommends continue. The adversary identified a
   plain-arm hash gap and a control-comparator gap. The implementation and
   receipt now close both gaps. The judge rules **continue** under the
   owner-set portability policy. The target group remains a hypothesis.

## Observed Evidence

* The measured source is `65bbc8f1811254ef5ab3ec0f8979620185753680`.
  The full receipt is
  [`experiments/webgl2-comparison/receipt.json`](../../experiments/webgl2-comparison/receipt.json).
* The fixture SHA-256 is
  `7cc1ebf47e08dff053cefdd10ff50989fac1ee58fa47d99ebdf75edec373c934`.
  It defines 152 occupied cells, 686 voxel levels, 180 path points, 20
  arrows, and 200 vector items. The geometry FNV64 is
  `6d6b287b56daf47a`.
* The Miniquad WASM arm builds voxel geometry with `companions/voxel` and
  vector geometry with `companions/draw`. It hashes the submitted geometry.
  The plain arm hashes the exact `Float32Array` and `Uint16Array` buffers
  that it passes to `bufferData`. Both hashes and count records match.
* The plain arm submits 2,476 vertices and 3,684 indices. Both browser arms
  use one static interleaved vertex buffer, one index buffer, and one draw
  for each enabled layer. Neither arm uses instancing.
* Browser A/A bounds are zero for both arms. Miniquad/WASM and plain WebGL2
  differ at zero pixels with tolerance two. Both outputs have opaque alpha.
  The 32 × 32 control changes 1,024 pixels in each arm when the same A/B
  comparator checks it.
* The Miniquad WASM arm and the plain WebGL2 arm each render 27,586
  non-background pixels. Both pass all layer and absent-sample checks. The
  native Metal capture passes the same checks and contains 27,586
  non-background pixels. The native/WASM comparison has zero differing
  pixels. This cross-API result is descriptive; it is not a gate.
* The native capture is
  [`artifacts/native-metal-640x400.rgba`](../../experiments/webgl2-comparison/artifacts/native-metal-640x400.rgba).
  Its SHA-256 is
  `72190cbf8ed5897144d0b856ec4464cf4780788bab210d23bc0ea106ac212ae1`.
  The native binary SHA-256 is
  `e5a9747cf361395c2bb0c66fb0efc950b4b3398f9898f4983a8baa367011369d`.
  The WASM binary SHA-256 is
  `c99456058be382846be67e70a6ccd2b862ea0bb026106dc7fd25de79508dfc2a`.
* The run took place from `2026-11-12T07:12:57Z` to
  `2026-11-12T07:17:06Z`. It used macOS 26.7.1 arm64, Apple M3 Pro, and
  Chromium 158.0.8127.18. WebGL was 2.0. ANGLE used the Apple M3 Pro Metal
  renderer. The drawing buffer used sRGB. AC power was active and Low Power
  Mode was disabled. The run did not instrument background workload.
* The toolchain was rustc 1.99.1 and Cargo 1.99.1. The native release build
  command was `CARGO_TARGET_DIR=target rustup run stable cargo build --release --manifest-path experiments/webgl2-comparison/rust/Cargo.toml`.
  It took 4.13 seconds wall time; Cargo reported a 3.95-second build. The WASM
  release build command was `CARGO_TARGET_DIR=target rustup run stable cargo build --release --target wasm32-unknown-unknown --manifest-path experiments/webgl2-comparison/rust/Cargo.toml`.
  It took 1.72 seconds wall time; Cargo reported a 1.62-second build.
* The native capture command was
  `CARGO_TARGET_DIR=target MINIQUAD_CAPTURE_PATH=experiments/webgl2-comparison/artifacts/native-metal-640x400.rgba rustup run stable cargo run --release --manifest-path experiments/webgl2-comparison/rust/Cargo.toml`.
  It wrote the committed Metal capture. The browser command was
  `MINIQUAD_HEADFUL=1 MINIQUAD_NATIVE_CAPTURE_PATH=experiments/webgl2-comparison/artifacts/native-metal-640x400.rgba MINIQUAD_SOURCE_SHA=65bbc8f1811254ef5ab3ec0f8979620185753680 node experiments/webgl2-comparison/verify-browser.mjs > experiments/webgl2-comparison/receipt.json`.
* Source line counts are 667 for Miniquad and 264 for plain WebGL2. Raw,
  gzip, and Brotli page sizes are 388,099 / 110,845 / 88,603 bytes for
  Miniquad, and 436,674 / 59,206 / 43,629 bytes for plain WebGL2.
* The paired median callback CPU delta is +0.1 ms. The bootstrap interval is
  `[0.099999994, 0.1000000015]` ms. The page was not cross-origin isolated.
  The measured callbacks use 0 and 0.1 ms values. Same-arm timing spread is
  also 0.1 ms. The timer cannot resolve an effect at this scale. The timing
  result is **INCONCLUSIVE**, not a regression or a speed gain. No GPU time
  was measured. The receipt is provisional until a valid GPU timer is
  available.
* Frame interval p50/p95/p99 is 8.3 / 9.3 / 9.4 ms for Miniquad and
  8.3 / 9.3 / 9.9 ms for plain WebGL2. Cold startup median/p95 is
  39.69 / 56.38 ms for Miniquad and 39.94 / 54.84 ms for plain WebGL2.
  These values describe one host and browser only.
* Implementation elapsed time was not tracked. Firefox, WebKit, mobile
  browsers, iOS Safari, input, clipboard, and context-loss tests did not run.
  This comparison is not browser qualification or user research.

## References

* [#157 continue-or-freeze gate](https://github.com/Tigon32/miniquad/issues/157)
* [MADR 0005 — Low-cost CI](0005-low-cost-ci-and-risk-based-test-lanes.md)
* [MADR 0007 — Supported tools](0007-use-supported-and-secure-toolchains.md)
* [MADR 0016 — Modern platform support](0016-modern-platform-support-policy.md)
* [MADR 0023 — WebGL2 GPU timer query](0023-webgl2-gpu-timer-query.md)
