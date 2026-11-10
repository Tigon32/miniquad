# Pinned Binaryen WebAssembly optimizer experiment

* Review date: 2026-11-10
* Tracking issue: [#14](https://github.com/Tigon32/miniquad/issues/14)
* Source comparison: the **same** release quad and offscreen WASM artifacts, before and after Binaryen `wasm-opt -Oz`
* Tool: Binaryen `version_133`, Linux x86_64 GitHub release, published 2026-09-21
* Archive SHA-256: `2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489`
* Status: **Unpromoted candidate; measurements and functional checks are required**

## Procedure

`.github/workflows/wasm-opt-binaryen-experiment.yml` downloads the named
archive from the official Binaryen GitHub release and validates its **pinned
digest before unpacking or running the binary**. It builds Miniquad's existing
release quad/offscreen fixtures with the same Rust version and source commit,
then optimizes copies with `wasm-opt -Oz`.

The workflow compares raw, gzip and Brotli bytes, SHA-256 and signed deltas
against the identical pre-optimization files. It runs all checked-in Playwright
tests against the **optimized** WASM binaries in Chromium, Firefox and WebKit,
and retains the comparison and browser receipt artifact for 14 days.

The test is an isolated candidate run. It does not rewrite production WASM,
change the checked-in Cargo release profile, add a runtime dependency,
publish a release or promote a faster engine.

## Decision criteria

* Require a positive measured compressed transfer benefit, not merely a
  reduction in uncompressed WASM bytes.
* Require actual ABI v3, offscreen rendering, keyboard/pointer, context-loss,
  clipboard and loader runtime parity in all three browser engines.
* Report matched CPU/GPU execution times, variability and browser versions
  before claiming a frame-time speedup. A size-only result is not proof.
* Preserve source and output hashes, exact Binaryen archive digest and Rust
  compiler version in every comparison.
* Record any rejected or losing experiment with its measured size deltas.
* Promote a candidate only in a follow-up PR that explicitly changes the
  build pipeline after a reviewed decision.

Native mobile browsers, peak GPU memory, physical input latency and
statistically calibrated frame p95/p99 behavior remain out of scope.
