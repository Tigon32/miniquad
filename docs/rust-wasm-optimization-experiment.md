# Rust/WASM release optimization experiment

* Review date: 2026-11-10
* Tracking: [#14](https://github.com/Tigon32/miniquad/issues/14)
* Comparator: source-identical baseline `cargo build --release` versus isolated `RUSTFLAGS="-C opt-level=z"` candidate
* Status: **Measurement experiment, not a promoted production optimization**

## Experimental design

The workflow `.github/workflows/wasm-opt-experiment.yml` compiles two
independent release builds of the quad and offscreen examples from the **same**
commit and Rust toolchain. The baseline uses the checked-in `Cargo.toml`
release profile (including size-oriented `opt-level=s`). The candidate
uses an explicit Rust code-generation override `-C opt-level=z` and an
isolated `CARGO_TARGET_DIR=target/experiment`. No production profile changes
in this PR.

The comparison script records the raw, gzip level 9, and Brotli quality 11
bytes, SHA-256 for each executable and the signed/percentage difference.
It writes `test-results/rust-wasm-optlevel-comparison.json` and the workflow
uploads that file with its exact source head, runner, compiler and
browser acceptance evidence.

The workflow then copies the **candidate** WASM examples into the browser
fixture and requires the existing functional Playwright tests to pass for
Chromium, Firefox and WebKit. This checks semantic parity on the candidate,
not just a compilable candidate. Browser performance baseline attachments
are retained for the candidate so a reviewer can inspect observed timing
changes, but single-run p95 numbers are not a statistically calibrated
speedup.

## Promotion criteria

1. Both baseline and candidate must have actual size receipts from the
   same revision and toolchain.
2. Candidate must pass all three engine functional tests, including ABI v3,
   offscreen render target, key/focus, clipboard and context loss.
3. Compare compressed transfer bytes, not just raw WASM bytes.
4. Collect repeated, matched browser timing measurements and report
   uncertainty before promoting any performance claim.
5. Keep the experiment in an isolated workflow. Change the release profile
   only in a subsequent separately reviewed PR with demonstrated net value.

No GPU memory or real-device CPU profiling is collected here. Reference
device qualification, `wasm-opt` (Binaryen) toolchain pinning and GL
submission profiling remain separate experiments. Binaryen is **not**
silently installed or claimed to be qualified; a future wasm-opt trial
must pin and review an exact tool version.
