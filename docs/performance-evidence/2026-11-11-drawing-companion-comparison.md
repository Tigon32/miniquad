# Drawing companion: pinned-Lyon comparison and browser qualification receipt — 2026-11-11

**Evidence status:** Measured, source-linked receipt for the exact
revision below. **Not** a performance-budget claim, not a promoted
optimization, and not a cross-device measurement. Closes the remaining
measurement gaps for [#123](https://github.com/Tigon32/miniquad/issues/123)
("Supply optional vector drawing tools outside Miniquad core"); see
[docs/drawing-companion.md](../drawing-companion.md) for the full written
evidence this summarizes.

- Source revision: `f837a98d415262320a8c66ef9f8024d8f2faeab1` (worktree
  `/Users/anton.junlen/projects/miniquad-draw-qualification`, branch
  `feat/draw-qualification`; unchanged for the entire session that
  produced this receipt).
- Fixtures: `experiments/drawing-comparison` (isolated benchmark-only
  crate, mutually exclusive `internal`/`lyon` Cargo features),
  `companions/draw/examples/showcase.rs` (GPU-release/QC-panel fixture),
  `experiments/drawing-comparison/external-consumer` (fresh consumer
  crate).
- Toolchain: `rustc 1.99.0 (b940084d7 2026-09-28)`, Node `v26.10.0`,
  Playwright `1.56.1` (resolved from a symlinked parent checkout's
  `node_modules`; no `npm` package-manifest change made).
- Browser/OS: real headless Chromium, Firefox, and WebKit (the versions
  Playwright 1.56.1 pins), launched by Playwright's own browser
  installs, on macOS 26.7.1 (build 25G241).
- **Host note:** one shared, non-dedicated development machine, not an
  isolated benchmark rig. No claim is made about absolute background
  load; the paired-runtime comparison below is reported `inconclusive`
  for this reason, per the Performance proof skill's instruction not to
  claim a speed win when sample ranges overlap.
- Raw JSON/log receipts: retained outside this repository's git history
  (gitignored `test-results/`, not committed), with SHA-256 below so
  they can be matched if produced again from the same commands.

## 1. WASM artifact sizes and hashes (raw / gzip-9 / Brotli, Node `zlib`)

Workload: `experiments/drawing-comparison/src/workload.rs` — 50
rectangles, 50 triangles, 20 circles (radius 20), 10 stroked cubic
curves (tolerance 0.5, thickness 2.0) — identical for both backends.

| Backend | SHA-256 | Raw bytes | gzip bytes | Brotli bytes |
| --- | --- | ---: | ---: | ---: |
| `internal` (this companion) | `6789c35ee301882e2edb3606fa49eab2ba92fba460d33196e8e6acb209f7c6d4` | 74223 | 26438 | 22670 |
| `lyon` (pinned `lyon_tessellation = "=1.0.23"`, `lyon_path = "=1.0.19"`) | `54c8fd0b62bf9806dab17819f4580a5b520fcc7445a850727fef06879a2684cf` | 196415 | 68011 | 57923 |
| Delta (lyon − internal) | — | +122192 | +41573 | +35253 |

Command:

```sh
node scripts/compare-drawing.mjs
```

Output (this run): `test-results/drawing-comparison.json`, SHA-256
`c0270aa05ebca7e8a8dd621184934bab6119670445894ac7f685c96586eeb887`.

## 2. Correctness tolerances (equal bounded workload, not pixel-exact)

| Shape | Agreement |
| --- | --- |
| Rectangle fill area | Exact (both are two-triangle quads) |
| Triangle fill area | Exact (both are a single filled triangle) |
| Circle fill area (radius 20, 20 segments) | ~1.9% difference (Lyon's adaptive arc approximation vs. this companion's fixed-segment fan) |
| Stroked cubic curve area (tolerance 0.5, thickness 2.0) | ~0.1% difference (different flattening/stroking algorithm, butt caps both sides) |

No join, cap, or dash-pattern parity is claimed; see
[docs/drawing-companion.md](../drawing-companion.md#comparison-evidence-and-artifact-receipt)
for the per-shape method.

## 3. Paired runtime (5 repeats each, Node WebAssembly, not a browser)

| Backend | Samples (ms) | Median (ms) |
| --- | --- | ---: |
| `internal` | 0.6399, 0.0445, 0.0454, 0.0487, 0.0433 | 0.0454 |
| `lyon` | 1.5342, 0.1520, 0.1347, 0.1388, 0.1395 | 0.1395 |

**Classification: `inconclusive`.** The first sample of each backend is
a cold-start/JIT-warmup outlier roughly 10x the rest; excluding it would
require changing the measurement method after seeing the data, so it is
reported as-sampled. This is **not** a GPU frame-time or upload
measurement — neither backend touches a GPU in this comparison, only
CPU-side tessellation into a `Vec<Vertex>`/`Vec<u16>`.

## 4. GPU release proof (real browser, not simulated)

Fixture exports (`companions/draw/examples/showcase.rs`, app-specific,
not a core ABI change): `request_gpu_release()`, `resources_live()`,
`request_empty_frame()`. Updated showcase artifact:
`companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm`,
raw 219008 / gzip 67826 / brotli 56782 bytes, SHA-256
`ef3d991b2d482da978bef486084fd0873397e1bd8cbd1fcd16937e83ce2f0c0c`.

Command:

```sh
cargo build --release --target wasm32-unknown-unknown \
    --manifest-path companions/draw/Cargo.toml --example showcase
DRAWING_QUALIFICATION_PORT=4280 node node_modules/.bin/playwright test \
    --config experiments/drawing-comparison/playwright.config.mjs
```

Result (this run): **23 passed, 0 failed, 0 flaky** —
chromium/firefox/webkit (7 tests each: render, resize, empty-batch,
clip, opacity, draw-order, GPU-release-exactly-once) plus
`chromium-dpr1`/`chromium-dpr2` (1 DPR-render test each).
`{"startTime":"2026-11-11T07:44:35.717Z","duration":17064.838,"expected":23,"skipped":0,"unexpected":0,"flaky":0}`.
Full JSON reporter output: `test-results/drawing-browser-qualification.json`,
SHA-256 `2e660f15dd1c9d627c73f720ec9e07dbfb63466f16de2461e0c54b79b44918ce`.

GL object creation/deletion is counted by `page.addInitScript`-installed
wrappers around `WebGLRenderingContext.prototype.{create,delete}{Buffer,Shader,Program}`.
The GPU-release test asserts: at least one program and two buffers
created at startup; after `request_gpu_release()`, exactly one program
deleted, every created buffer deleted, no new program created, and a
second release request is a no-op (idempotent).

## 5. External consumer render proof (real browser, public API only)

Fresh crate `experiments/drawing-comparison/external-consumer`
(`drawing-external-consumer`) depends on `miniquad-draw` via a path
dependency (the equivalent of a pinned Git dependency before a
crates.io release); no source copied. `examples/consume.rs` draws one
rectangle and one circle using only the companion's public
`Batch`/`Color`/`Rect`/`Renderer`/`Transform2D` API.

Commands:

```sh
cargo build --release --target wasm32-unknown-unknown \
    --manifest-path experiments/drawing-comparison/external-consumer/Cargo.toml --example consume
node experiments/drawing-comparison/verify-consumer-render.mjs
```

WASM artifact:
`experiments/drawing-comparison/external-consumer/target/wasm32-unknown-unknown/release/examples/consume.wasm`,
raw 208227 bytes, SHA-256
`8ef94fd98f56792c82195bd780e52e59c289de39f70abd96ed9e667b1cc38404`.

Result (this run): `{"colorCount":12,"consoleErrors":[]}`, `PASS`.
Logged to `test-results/drawing-external-consumer-render.log`, SHA-256
`85ff1c9fe0fb096a70f900195e5acd2879c13fc7018cf16f25878bbfa01ce4f6`.

## 6. Limits of this receipt

- Runtime comparison is CPU-only and `inconclusive`; it is not a frame
  time, upload time, or GPU timing measurement for either backend.
- Correctness equivalence is area-based and tolerance-bound, not
  pixel-exact; it does not cover join/cap/dash parity.
- Only Chromium was used for `deviceScaleFactor` (DPR) emulation;
  Firefox/WebKit DPR behavior was not separately exercised.
- Native-platform window rendering was not verified for either
  `companions/draw` or the external consumer in this receipt.
- All measurements were taken on one shared development machine, not a
  dedicated or isolated benchmark host.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
