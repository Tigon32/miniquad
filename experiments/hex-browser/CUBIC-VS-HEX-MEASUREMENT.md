# Cubic vs hex: equal-cell measurement receipt

Issue #131, measurement acceptance. **STE-aligned draft.** Full
ASD-STE100 dictionary review not done.

**Measurement status: complete.** The test ran 20 alternating pairs in
Chromium, Firefox, and WebKit. It used equal cell inputs. The measured
geometry differs by topology. Do not read these results as a speed claim.
Issue #131 stays open until the PR review and merge flow finish.

## Source and conditions

- Source: `590764f906432d2fc6b7a01374ec0ae52266c919`, branch
  `feat/hex-browser`.
- Host: macOS 26.7.1, Darwin 25.6.0, arm64, Apple M3 Pro.
- Toolchain: `rustc 1.99.1 (58cf8f9c3 2026-10-13)`, `cargo 1.99.0`,
  Node.js `v26.10.0`, Playwright `1.56.1`.
- Browser versions: Chromium `141.0.7390.37`, Firefox `142.0.1`,
  WebKit `26.0`.
- Build target: `wasm32-unknown-unknown`, release profile.
- Both scenes used WebGL1, a 640x360 CSS canvas, DPR 1, seed `20261111`,
  and two resident chunks.
- Both measurement scenes used `ChunkDims(8, 4, 8)` and chunk coordinates
  `(-1, 0, 0)` and `(0, 0, 0)`.
- The cubic fixture used the opt-in `measurement-equal-cells` feature.
  The default cubic example stays at `8x12x8` and coordinates
  `(0, 0, 0)` and `(1, 0, 0)`.
- Both scenes had 512 grid cells and 383 solid cells. Their mesh
  topologies differ, so their vertex and index counts differ.
- The test ran 40 page loads per engine: 20 per scene and 20 alternating
  pairs. Each run sampled 60 animation-frame intervals and dropped the
  first sample. The test reports each run's p95 and p99, then the
  minimum, mean, and maximum of 20 run results.
- `js/gl.js`: 79,921 bytes, gzip 17,920 bytes, SHA-256
  `619ec1a0f38008a682677b055b617c2da687908ff6b2130e3d61c68b0af83ca7`.
- The build emitted a `rust-objcopy` warning because `libLLVM.dylib` is
  missing. All fixture builds exited successfully.

The fixture build command was:

```sh
RUSTC="$(rustup which rustc)" node experiments/hex-browser/build-fixtures.mjs
```

The browser measurement command ran the spec in one Playwright invocation
so that all three engine results were retained:

```sh
RUSTC="$(rustup which rustc)" ./node_modules/.bin/playwright test \
  --config=experiments/hex-browser/playwright.config.mjs \
  experiments/hex-browser/tests/cubic-vs-hex-measurement.spec.mjs
```

## Mesh data

The native helper ran 20 alternating builds per scene in each browser test
process. It asserted that cell counts and mesh counts stayed deterministic.
Build times are host CPU time, not browser or WASM build time.

| Engine | Scene | Grid cells | Solid cells | Vertices | Indices | Build min ns | Mean ns | p95 ns | p99 ns | Max ns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | cubic | 512 | 383 | 2392 | 3588 | 33625 | 41054 | 52292 | 99917 | 99917 |
| Chromium | hex | 512 | 383 | 3888 | 6600 | 74333 | 81568 | 103917 | 136209 | 136209 |
| Firefox | cubic | 512 | 383 | 2392 | 3588 | 33458 | 40052 | 40917 | 121125 | 121125 |
| Firefox | hex | 512 | 383 | 3888 | 6600 | 74625 | 80283 | 101750 | 109625 | 109625 |
| WebKit | cubic | 512 | 383 | 2392 | 3588 | 33875 | 75716 | 115458 | 119333 | 119333 |
| WebKit | hex | 512 | 383 | 3888 | 6600 | 74667 | 161968 | 225208 | 266375 | 266375 |

These are native CPU measurements. Neither scene exports a browser mesh-build
probe. No browser build-time result is claimed.

## WASM and JavaScript sizes

| Asset | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Cubic measurement WASM | 221296 | 69000 |
| Hex WASM | 242086 | 76420 |
| Shared `js/gl.js` | 79921 | 17920 |
| Cubic WASM plus JS | 301217 | 86920 |
| Hex WASM plus JS | 322007 | 94340 |

The combined gzip value is the sum of the separately measured WASM and
JavaScript gzip sizes. The test measured WebGL1 WASM sizes.

## Frame intervals

Values are milliseconds. Each min, mean, and max is over 20 run-level
percentiles for that scene. Means are rounded to three decimal places.

| Engine | Scene | p95 min | p95 mean | p95 max | p99 min | p99 mean | p99 max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | cubic | 17.50 | 21.945 | 39.00 | 18.00 | 28.665 | 71.80 |
| Chromium | hex | 16.90 | 27.830 | 70.50 | 18.20 | 36.635 | 82.90 |
| Firefox | cubic | 9.00 | 10.300 | 16.00 | 10.00 | 11.850 | 20.00 |
| Firefox | hex | 9.00 | 10.350 | 17.00 | 10.00 | 11.750 | 24.00 |
| WebKit | cubic | 18.00 | 19.600 | 24.00 | 18.00 | 23.250 | 74.00 |
| WebKit | hex | 18.00 | 19.500 | 23.00 | 18.00 | 25.000 | 71.00 |

The host was shared and the browsers ran headless. Some p99 ranges are wide.
This is not a controlled performance benchmark. No speed or performance
promotion claim is made.

## WebGL and GPU limits

| Engine | WebGL version | Renderer string | Result |
| --- | --- | --- | --- |
| Chromium | WebGL 1.0 | ANGLE / Vulkan / SwiftShader | Software renderer, confirmed by the harness launch flags |
| Firefox | WebGL 1.0 | `Apple M1, or similar` | Masked or generic. The physical GPU is not confirmed. |
| WebKit | WebGL 1.0 | `Apple GPU` | Generic renderer string. The physical GPU is not confirmed. |

WebGL does not provide a portable VRAM query. VRAM and driver-memory values
are `null`, not estimated. The WebKit run is desktop WebKit, not iOS Safari.
Mobile browsers and a dedicated hardware benchmark were not tested.

## Test results

- `cargo test` in `companions/voxel`: passed, 88 tests.
- `cargo check --release --example offline`: passed; default cubic profile.
- `cargo check --release --example offline --features measurement-equal-cells`:
  passed.
- `cargo build --release --target wasm32-unknown-unknown --example offline`:
  passed; default cubic profile.
- `node --test tests/*.test.cjs`: passed, 85 tests.
- `npm run lint:js`: passed.
- The private fixture build: passed for hex WebGL1, hex WebGL2, and the
  cubic equal-cell profile.
- The measurement spec: passed, 3 tests, one per engine.
- `hex-offline.spec.mjs`: passed, 54 tests across Chromium, Firefox, and
  WebKit. This includes WebGL1/2 selection, picking, silhouettes, seams,
  DPR, occlusion, release, and downstream builds.
- `hex-offline.spec.mjs --grep "honest measurements"`: passed, 3 tests across
  Chromium, Firefox, and WebKit.
- `npm run ci:local`: passed on the Linux/arm64 local runner at source
  `590764f906432d2fc6b7a01374ec0ae52266c919`.
- `node scripts/check-docs.mjs`: passed.

The raw per-engine JSON records were saved outside the repository. The test
can save records with `HEX_BROWSER_ARTIFACT_DIR`; otherwise it writes to the
gitignored `test-results/hex-browser/measurements` directory.

## Reproduction

Use a Rust compiler with the `wasm32-unknown-unknown` target. Run the fixture
build command above, then run the measurement command above. The Playwright
spec records the source SHA, browser version, OS, WebGL version and renderer,
cell counts, mesh counts, byte sizes, and frame-interval ranges.

**Scope:** This receipt completes the measurement item for issue #131. It
does not close the issue or claim that desktop WebKit tests iOS Safari.
