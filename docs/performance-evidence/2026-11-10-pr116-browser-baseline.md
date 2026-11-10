# Browser and build baseline — PR #116 CI

**Evidence status:** Measured CI baseline for the exact PR head, **not** release qualification, a candidate-vs-baseline performance improvement, or a full browser matrix.

- Source: `8706f6ffa9f9de46253c0b4062475bc0cb12f853` (PR #116 head).
- GitHub Actions: [Miniquad integration CI run 42920947828](https://github.com/Tigon32/miniquad/actions/runs/42920947828), job `rust-wasm` 130195344338.
- Environment observed in logs: GitHub-hosted Linux runner, Node `v24.22.2`. Precise CPU, GPU and operating-system image version were not captured in this receipt.
- Commands recorded in log: `cargo test --lib`, `cargo check --target wasm32-unknown-unknown --lib`, `cargo build --release --target wasm32-unknown-unknown --example quad --example offscreen`, `node scripts/measure-bundle-size.mjs` and `npm run test:browser:chromium`.
- Outcomes observed: 10 Rust unit tests passed; compilation and release WASM example build succeeded; 21 Chromium browser tests passed. These outcomes apply to the referenced PR head, **not automatically to a later merge SHA**.
- Note: the previous CI run on PR #116 failed the ADR index check; this source revision includes its correction.

## Actual artifact compression measurements

The CI script produced the following measurements using Node zlib gzip level 9 and Brotli quality 11. They represent local file compression, **not measured HTTP transfer bytes**. The same recorded SHA-256 values are required to compare artifacts in another environment.

| Artifact | SHA-256 | Raw bytes | gzip bytes | Brotli bytes |
| --- | --- | ---: | ---: | ---: |
| `js/gl.js` | `e1f8642299ff85dbbf6306833d0428a2dbbebf12f51a9b3e610d44fd1aa84bad` | 78,037 | 17,215 | 14,379 |
| `quad.wasm` | `41294395503b062679feff3e5ba9f8e85e1772d6c8aff7890c8456467f943615` | 114,018 | 44,906 | 37,427 |
| `offscreen.wasm` | `fb24b91953102ddef42f27698ab6b51c4388902155b043034889bd859e80664c` | 117,381 | 45,585 | 38,025 |

WASM artifacts came from `target/wasm32-unknown-unknown/release/examples/`. The file pair was built from the tested checkout. No HTTP caching or transfer timing was measured.

## Chromium browser measurements

The CI browser receipt reported:

| Measurement | Recorded value |
| --- | ---: |
| First WASM frame callback | 48.7 ms (approximate displayed precision) |
| First WebGL draw submission | Unavailable (`null`) |
| Warm frame interval sample count | 79 |
| Frame interval p50 | 16.6 ms |
| Frame interval p95 | 16.8 ms |
| Frame interval p99 | 33.3 ms |
| JS-to-WASM frame call samples | 40 |
| JS-to-WASM frame call p50 | 0.1 ms |
| JS-to-WASM frame call p95 | 0.2 ms |
| JS-to-WASM frame call p99 | 0.3 ms |

**Interpretation limits:** Measurements are warm-running browser samples. The first WASM frame callback does not prove first visible pixels; a `null` draw submission must not be reported as zero. JS-to-WASM callback duration includes CPU GL submission, not GPU completion. Sample sizes are small. No device specification, GPU memory, input-to-visible latency, Firefox/WebKit run, physical iOS/Android run, cold-start distribution, or candidate regression delta is established.

## Browser test scope

All 21 Chromium tests passed in this run. The log includes compiled ABI imports/exports, Unicode clipboard, oversized-paste rejection, clock behavior, context loss/restoration, missing WASM/canvas/WebGL/version errors, keyboard focus, offscreen render, pointer/clipboard isolation, ownership transfer, actual rendered pixels, and resize.

## Remaining work before issue closure

- [ ] Record a source-paired candidate build and repeatable baseline/candidate comparisons with controlled hardware and representative workloads.
- [ ] Run Firefox and WebKit acceptance, and separately record mobile qualification.
- [ ] Measure CPU/allocation/GL submission hotspots, first visible pixel, memory, and frame interval variability with repeated browser trials.
- [ ] Evaluate `wasm-opt`, release profiles, upstream buffer upload #682 and texture cache #691 against correctness and confidence criteria.
- [ ] Exercise a tagged release candidate and rollback, and evaluate applicable security findings before approving #19.

This document is evidence toward [#14](https://github.com/Tigon32/miniquad/issues/14) and [#19](https://github.com/Tigon32/miniquad/issues/19). Neither issue is closed.
