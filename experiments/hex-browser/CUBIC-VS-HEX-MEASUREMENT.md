# Cubic vs hex: paired measurement receipt

Issue #131, "measurement" acceptance item. STE-aligned draft; full ASD-STE100
dictionary review not done.

**Status: partial.** The required equal-cell workload is not met. This receipt
measures the current examples with their actual configurations. Do not read the
results as a direct performance comparison or a speed claim. The browser run
uses 20 alternating page loads per engine, or 10 samples per scene. It does not
meet the requested 20 paired runs.
The measurements were collected at `a98966a350e64f7de6bc10dc0086e938366f62ed`,
before this branch merged `origin/master` at
`80e03a6f11624095a4d05abc3fd66a12713f99de` and the later master update
`b83f88f9a4a834637e40fd4a6335ff27761cffa7`. They were not rerun on the merged
source revision. A fresh measurement-fixture build is blocked on the host:
`node experiments/hex-browser/build-fixtures.mjs` fails because the
`wasm32-unknown-unknown` target is not installed; `rustup` is unavailable.
`npm run ci:local` passed on the merged source, but it runs the root Chromium
smoke lane and does not build or run this experiment's measurement fixture.

## Source and conditions

- Measurement source SHA: `a98966a350e64f7de6bc10dc0086e938366f62ed` (branch `feat/hex-browser`).
- Hex example source SHA before the measurement fixture:
  `b76bb0f4cc25cd185b7bf2559e862bbe37128f01`.
- Host: Darwin 25.6.0, macOS 26.7.1, Apple M3 Pro (arm64).
- Compiler: `rustc 1.99.0 (b940084d7 2026-09-28) (Homebrew)`.
- Test commands:
  - `node experiments/hex-browser/build-fixtures.mjs`
  - `npx playwright test --config=experiments/hex-browser/playwright.config.mjs --project=<chromium|firefox|webkit> --grep "paired/alternating"`
  - (uses `cargo run --release --example measure_mesh` internally; `companions/voxel/examples/measure_mesh.rs`)
- Test file: `experiments/hex-browser/tests/cubic-vs-hex-measurement.spec.mjs`.
- Canvas: 640x360 CSS pixels, device pixel ratio 1, both scenes, all three engines.
- World seed: `20261111`, 2 resident chunks (`MAX_RESIDENT_CHUNKS = 4`), both scenes.
- Browser runs per engine: 20 alternating page loads (hex, cubic, hex, cubic, ...).
  This is 10 samples per scene, not 20 pairs. The cell counts differ because the examples use
  different chunk dimensions; this is not an equal-cell workload.
- The cubic baseline is the UNCHANGED `companions/voxel/examples/offline.rs`,
  built and served privately on this harness's own port 4290 (see
  `build-fixtures.mjs`'s `buildCubicMeasurementFixture` and
  `cubic-measurement.html`). It is never read as a module or edited, and the
  root-owned port 4173/4174 harness (`tests/browser/serve.mjs`,
  `tests/browser/starter.spec.mjs`) is never touched.

## Known, real differences (not forced to match)

- `ChunkDims`: cubic `(8, 12, 8)`, hex `(8, 4, 8)`. Both share the same 8x8
  X/Z footprint and chunk coordinates (`(0,0,0)`/`(1,0,0)` cubic,
  `(-1,0,0)`/`(0,0,0)` hex), but the hex scene has fewer Y layers. This is a
  real property of each example, not a test artifact, so solid-cell and
  vertex/index counts are expected to differ and are reported as-is.
- Neither example exports a build-time probe (adding one to `offline.rs` is
  against the issue's "stays unchanged" rule), so no in-browser/WASM
  build-time claim is made for either scene. The build-time numbers below are
  from a native (non-browser) host binary, clearly labeled as such.

## Exact, deterministic mesh data (native host, not browser-measured)

From `cargo run --release --example measure_mesh` (asserted internally to be
identical across all 20 of its own alternating runs, and reproduced
identically by every engine's run of the Playwright spec below):

| Scene | Vertices | Indices |
| --- | --- | --- |
| cubic | 5552 | 8328 |
| hex | 3888 | 6600 |

Native mesh-build time (nanoseconds, same host, 20 alternating runs; this is
host build time, not an in-browser measurement):

| Scene | min | mean | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| cubic | ~73,600–74,200 | ~85,500–109,500 | ~103,500–225,900 | ~153,600–259,900 | ~153,600–259,900 |
| hex | ~73,700–73,800 | ~82,700–100,200 | ~106,900–227,900 | ~107,500–230,800 | ~107,500–230,800 |

(Ranges above span the three per-engine Node processes that invoked the same
native binary; see the per-engine JSON artifacts under
`test-results/hex-browser/measurements/cubic-vs-hex-<project>.json`,
gitignored, for exact single-run figures.)

## WASM and JS byte sizes (identical across all three engines, same build)

| Asset | Raw bytes | Gzip bytes |
| --- | --- | --- |
| cubic WASM (`offline.wasm`, WebGL1) | 220,817 | 68,995 |
| hex WASM (`offline_hex.wasm`, WebGL1) | 241,622 | 76,385 |
| `js/gl.js` (shared by both scenes) | 78,360 | 17,478 |

## Real browser-measured frame-interval percentiles (ms)

20 alternating page loads per engine; 10 runs land on each scene. Each run
samples 60 `requestAnimationFrame` intervals (first sample dropped) and
computes that run's own p95/p99; the table below is the range and mean of
those 10 per-scene p95/p99 values, not a single sample.

### Chromium 141.0.7390.37 (ANGLE/SwiftShader, confirmed software; see GPU note)

| Scene | p95 min | p95 mean | p95 max | p99 min | p99 mean | p99 max |
| --- | --- | --- | --- | --- | --- | --- |
| cubic | 19.8 | 29.34 | 89.0 | 20.3 | 40.88 | 162.7 |
| hex | 19.4 | 25.16 | 36.4 | 20.3 | 30.06 | 49.2 |

### Firefox 142.0.1

| Scene | p95 min | p95 mean | p95 max | p99 min | p99 mean | p99 max |
| --- | --- | --- | --- | --- | --- | --- |
| cubic | 9 | 9.70 | 10 | 10 | 10.50 | 13 |
| hex | 9 | 10.80 | 23 | 9 | 11.60 | 24 |

### WebKit 26.0 (desktop, macOS; not iOS Safari)

| Scene | p95 min | p95 mean | p95 max | p99 min | p99 mean | p99 max |
| --- | --- | --- | --- | --- | --- | --- |
| cubic | 18 | 19.6 | 22 | 18 | 21.80 | 37 |
| hex | 18 | 19.6 | 22.0 | 18 | 23.30 | 36 |

No performance-promotion claim ("cubic/hex is faster/better") is made from
this data: this is a shared, non-dedicated host running headless browsers
under test-harness load, not a controlled performance-benchmarking
environment, and the two scenes render different geometry (see "known, real
differences" above).

## GPU identity (honest, not fabricated)

A one-off renderer/vendor probe (not part of the committed spec, run and
discarded) reports:

| Engine | `UNMASKED_RENDERER_WEBGL` | Note |
| --- | --- | --- |
| Chromium | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...), SwiftShader driver)` | confirmed software rendering (SwiftShader), per this harness's own `--use-angle=swiftshader` launch flag |
| Firefox | `Apple M1, or similar` | Firefox returns a masked/generic string; this is NOT confirmed as software-only, and NOT confirmed as this host's real M3 Pro GPU either |
| WebKit | `Apple GPU` | generic string; likely the host's real GPU via macOS's native WebKit GPU backend, not independently confirmed |

No VRAM, driver-memory, or other GPU resource-usage value is measured or
estimated for any engine; `gpuMetricsUnavailable.vramBytes` is `null` with a
stated reason in every JSON artifact (WebGL has no portable query for it).

## Scope not covered by this receipt

- iOS Safari, Android Chrome, and any other mobile/real-device engine: not
  installed/available in this environment: **blocked**, not claimed.
- A controlled, dedicated-hardware performance benchmark: this host is shared
  with other users/agents and the browsers ran headless under a test
  harness; the frame-interval numbers above are real measurements taken
  under those real (not idealized) conditions, and are reported as such,
  not as a performance claim.

## Reproduction

```sh
export PATH="$HOME/.cargo/bin:$PATH"   # rustup toolchain with wasm32 target
node experiments/hex-browser/build-fixtures.mjs
npx playwright test --config=experiments/hex-browser/playwright.config.mjs \
  --project=chromium --grep "paired/alternating"
npx playwright test --config=experiments/hex-browser/playwright.config.mjs \
  --project=firefox --grep "paired/alternating"
npx playwright test --config=experiments/hex-browser/playwright.config.mjs \
  --project=webkit --grep "paired/alternating"
```

Each run writes
`test-results/hex-browser/measurements/cubic-vs-hex-<project>.json`
(gitignored; Playwright clears its `test-results/` output directory at the
start of every invocation, so copy a run's JSON elsewhere before running
another Playwright command if it must be kept).
