# Compare Miniquad with plain WebGL2 before a continue-or-freeze decision

* Status: **Proposed**
* Date: 2026-11-11
* Tracking: [#157](https://github.com/Tigon32/miniquad/issues/157); related [#14](https://github.com/Tigon32/miniquad/issues/14), [#19](https://github.com/Tigon32/miniquad/issues/19), [#22](https://github.com/Tigon32/miniquad/issues/22), [#29](https://github.com/Tigon32/miniquad/issues/29), [#154](https://github.com/Tigon32/miniquad/issues/154), and [#156](https://github.com/Tigon32/miniquad/issues/156)
* Source: `5be67a3b89597b56dffb847c054dab352e378725`
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

**Proposed:** run the comparison and record its evidence before closing #157.
The owner-set policy is that native-plus-web portability is required. Do not
describe this policy as confirmed user demand. The comparison can test
feasibility and report performance. It cannot establish user demand.

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
  loads. Use the same isolated page and wrapper for each arm. The wrapper
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
  zero; a regression is supported only when it is above zero. Otherwise
  report **INCONCLUSIVE**. This rule does not turn timing into a decision
  gate.
* Report frame intervals, p50/p95/p99, cold startup, page asset sizes, and
  implementation effort as descriptive results. Do not select a secondary
  metric as a decision result after seeing the data.
* Record total page assets for each arm: raw, gzip, and Brotli bytes.
  Record the compression method, tool versions, source hashes, and build
  flags.
* Record implementation and build effort as elapsed time and commands. Count
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

1. Review and accept this design before building either comparison arm.
2. Commit the public fixture and schema. Verify its counts and input hash.
3. Verify browser pixel parity and the render-only control.
4. Build and run both native and WASM targets. Verify counts, geometry
   hashes, layer-specific pixel checks, nonempty frames, and record the
   cross-API pixel metrics.
5. Run the fixed measurement protocol in one source checkpoint.
6. Record all tests that did not run, then ask the council to review the
   receipt and decision.

## Observed Evidence

* The #14 profile receipt reports INCONCLUSIVE timing on a small
  `browser_perf` fixture.
* The current Miniquad profiler measures a Miniquad WASM fixture. It does
  not time a plain WebGL2 implementation.
* The private reference scene is not an independently accessible public
  test fixture.
* The public fixture now records the scene input, source counts, geometry,
  layer checks, coordinate order, level meaning, numeric encoding, and units.
  Its output counts match the fixed input contract above.
* The Miniquad arm builds voxel geometry with `companions/voxel` and vector
  geometry with `companions/draw`. It checks the submitted vertices, colors,
  indices, and layer ranges against the fixture before it renders.
* The plain WebGL2 arm uses the same fixture geometry. The browser verifier
  checks each arm's counts, geometry hash, layer samples, absent sample
  points, and render-only control.
* The native Metal capture passes the five layer samples and the absent
  sample-point check on macOS 26.7.1 arm64, Apple M3 Pro. The native capture
  stores top-left RGBA8 bytes after channel normalization.
* A headful Chromium run on the same host reports WebGL 2.0, an ANGLE Metal
  renderer, sRGB drawing buffers, zero same-arm pixel differences, and zero
  Miniquad/plain pixel differences. The 32 × 32 control changes 1024 pixels
  in each arm.
* The paired timing receipt has not run. Do not use the parity result as a
  performance result or as the council's final decision.

## References

* [#157 continue-or-freeze gate](https://github.com/Tigon32/miniquad/issues/157)
* [MADR 0005 — Low-cost CI](0005-low-cost-ci-and-risk-based-test-lanes.md)
* [MADR 0007 — Supported tools](0007-use-supported-and-secure-toolchains.md)
* [MADR 0016 — Modern platform support](0016-modern-platform-support-policy.md)
* [MADR 0023 — WebGL2 GPU timer query](0023-webgl2-gpu-timer-query.md)
