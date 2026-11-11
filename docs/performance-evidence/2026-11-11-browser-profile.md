# Browser-profiled paired baseline/candidate measurement — 2026-11-11

**Evidence status:** Measured paired browser receipt for the exact source
revision below. **Not** release qualification, not a promoted optimization,
and not a cross-engine or reference-device measurement. Contributes
evidence toward [#14](https://github.com/Tigon32/miniquad/issues/14), which
**remains open**.

- Source revision: `f0b0331bfda7feaf615a9779e6dc81c3e9805b6f` (worktree
  `feat/browser-profiling`, no uncommitted changes outside this evidence set
  at measurement time).
- Fixture: `examples/browser_perf.rs`. Harness: `scripts/profile-browser.mjs`
  (see [docs/browser-profiling.md](../browser-profiling.md) for exact
  semantics and instrumentation method).
- Comparator: source-identical `cargo build --release --target
  wasm32-unknown-unknown --example browser_perf` baseline versus an
  isolated `RUSTFLAGS="-C opt-level=z"` candidate built into a separate
  `CARGO_TARGET_DIR`. The checked-in release profile (`opt-level = "s"`,
  `lto = true`, `codegen-units = 1`, ...) is unchanged.
- Toolchain: `rustc 1.99.0 (b940084d7 2026-09-28)`, Node `v26.10.0`,
  Playwright `1.56.1` (resolved from a sibling worktree's
  `node_modules`, not installed by this change).
- Browser/OS/GPU mode: headless Chromium `141.0.7390.37` (pinned by the
  resolved Playwright install), launched with
  `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`
  (software rendering), viewport 640x400, `deviceScaleFactor: 1`. Host OS:
  macOS 26.7.1 (build 25G241).
- **Host note:** this is one shared, non-dedicated development machine, not
  an isolated benchmark rig or CI runner. Other work may have been running
  concurrently; no claim is made about absolute background load, and no
  process belonging to another task was stopped to take this measurement.
- Raw JSON receipt: retained outside this repository as a session artifact
  (not committed), SHA-256
  `05837e3cf9cc26e5be0e128d220bd06ffaf705148982c3daa6fac69bc5f0d841`,
  844 lines, containing per-pair detail this summary omits.

## Artifact sizes (raw / gzip-9 / Brotli-11, Node `zlib`)

| Build | SHA-256 | Raw bytes | gzip bytes | Brotli bytes |
| --- | --- | ---: | ---: | ---: |
| baseline `browser_perf.wasm` | `8d3720838d3111e5da6ea5bc4a86bdb4aded5b1972a383e295cc76cc6f167041` | 113,837 | 44,368 | 37,326 |
| candidate `browser_perf.wasm` | `8441c9e2c3a9b9c1a210dd979b0e6fd2a1f572c211876e7f0120fc134099a255` | 105,333 | 43,213 | 36,859 |

Candidate is **-7.47% raw, -2.60% gzip, -1.25% Brotli** versus baseline for
this fixture. This is consistent in direction with the prior `-C
opt-level=z` size result recorded in `docs/rust-wasm-optimization-experiment.md`
for `quad`/`offscreen`, on a different fixture and host.

## Paired timing comparison (5 pairs, alternating order)

Each pair ran 120 freeze-gated frames and at least 60 JS-to-WASM CPU
samples per variant. Per-pair delta (candidate minus baseline), the median
delta across all 5 pairs, the spread (max minus min delta), and the verdict
from `summarizePairs` (see `scripts/profile-browser.mjs`):

| Metric | Median delta | Spread | Verdict |
| --- | ---: | ---: | --- |
| Frame interval p50 (ms) | 0 | 0 | INCONCLUSIVE |
| Frame interval p95 (ms) | 0 | 0.2 | INCONCLUSIVE |
| Frame interval p99 (ms) | 0 | 0 | INCONCLUSIVE |
| JS-to-WASM frame CPU p50 (ms) | 0 | 0 | INCONCLUSIVE |
| JS-to-WASM frame CPU p95 (ms) | 0 | 0.1 | INCONCLUSIVE |
| JS-to-WASM frame CPU p99 (ms) | 0 | 0.2 | INCONCLUSIVE |

**Result: INCONCLUSIVE for every timing metric.** Observed deltas were at or
below the pair-to-pair noise spread (both at the 0.1 ms `performance.now()`
precision this browser/mode exposes). This fixture's workload is tiny
(single quad, 64+256+512+64 bytes of buffer upload and one draw per frame)
and the host is shared and non-dedicated, so this result does not support a
frame-time speedup or regression claim either way. No candidate is promoted
to the default release profile.

All 10 individual runs (5 baseline, 5 candidate) recorded frame interval p50
of ~16.7 ms (software-rendered vsync-paced) and JS-to-WASM CPU p50 of ~0.1
ms, well under a 16.7 ms budget; first WebGL draw submission was observed
at ~24-36 ms after navigation across runs (not a cold-start distribution,
one host, one engine).

## Functional parity (not just byte size)

Every one of the 5 pairs recorded **identical** WebGL counts between
baseline and candidate: 485 buffer upload calls, 108,696 buffer upload
bytes, 2 texture uploads (128 bytes, the two static textures created once),
244 `bindTexture` calls and 120 draw calls. WASM memory was 1,179,648 bytes
(18 x 64 KiB pages) for both variants in every pair. This confirms the
codegen-only candidate produces the same GPU submission behavior as the
baseline for this fixture, not just a smaller artifact.

**Deterministic-freeze pixel parity:** all 5 pairs read back the exact RGBA
framebuffer via `gl.readPixels` after the harness froze
`requestAnimationFrame` at frame 120. Every pair reported `maxChannelDiff:
0` and `mismatchedPixelRatio: 0` — byte-identical rendered output between
baseline and candidate at the frozen frame.

## Explicitly not measured here

- **Allocation/heap profiling.** Not available in this harness
  (`allocationProfiling.available: false` in every receipt). CDP
  `HeapProfiler` sampling was not implemented. #14's allocation and
  texture-cache-lifecycle comparisons (upstream `#691`) remain open.
- **GPU completion time.** Only JS-to-WASM CPU submission time was
  recorded; no GPU timer query was used, and no GPU time is reported as
  zero.
- **JS heap bytes.** `performance.memory.usedJSHeapSize` was available in
  this Chromium build but is a browser-rounded bucket value (`10,000,000`
  bytes identically across every run), not a precise or portable
  measurement; treat it as a coarse presence check, not a memory delta.
- Reference/mobile hardware, Firefox, WebKit, and native (non-WASM)
  builds: not exercised by this harness.
- CPU profile sampling (`Profiler.start`/`stop`) was collected per run and
  retained in the raw receipt; the dominant sampled node in every run was
  `(idle)`, consistent with a workload far under the frame budget on this
  host and not a meaningful hotspot signal for this tiny fixture.

## Remaining work before #14 closure

- [ ] Allocation/heap-topology comparison (CDP `HeapProfiler` or
      equivalent), and upstream buffer-upload (`#682`) /
      texture-cache (`#691`) specific regression review.
- [ ] A workload large/long enough, and a dedicated or CI-hosted runner,
      to produce a timing signal that exceeds this harness's observed
      ~0.1-0.2 ms noise floor.
- [ ] Firefox/WebKit and real-device corroboration.
- [ ] A decision gate per `docs/rust-wasm-optimization-experiment.md`
      before any release-profile change; this receipt does not meet that
      bar and does not request one.
