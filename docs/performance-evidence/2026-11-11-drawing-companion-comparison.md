# Drawing companion: pinned-Lyon comparison and browser qualification receipt — 2026-11-11

**Evidence status:** Measured, source-linked receipt for the exact
revision below. **Not** a performance-budget claim, not a promoted
optimization, and not a cross-device measurement. Closes the remaining
measurement gaps for [#123](https://github.com/Tigon32/miniquad/issues/123)
("Supply optional vector drawing tools outside Miniquad core"); see
[docs/drawing-companion.md](../drawing-companion.md) for the full written
evidence this summarizes.

- Source baseline: `f837a98d415262320a8c66ef9f8024d8f2faeab1` (core
  `miniquad`/`companions/draw` baseline this worktree branched from;
  not itself modified). New fixture, benchmark, and test code is
  committed on top of that baseline: `fd9481f` (Lyon benchmark crate,
  browser qualification suite, external consumer), `c1d2a9f` (original
  performance-evidence receipt), and `ae7c8556ef7893558b0532851eb47083c57873ee`
  (this receipt's fix commit — a real syntax-error fix in the browser
  spec, an `rustfmt` pass on the showcase fixture, and the
  tolerance/clean-tree/checksum-cross-check additions to
  `scripts/compare-drawing.mjs` described below). **Current HEAD for
  every measurement in this document is
  `ae7c8556ef7893558b0532851eb47083c57873ee`.**
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

| Backend | SHA-256 | Raw bytes | gzip-9 bytes | Brotli-11 bytes |
| --- | --- | ---: | ---: | ---: |
| `internal` (this companion) | `6789c35ee301882e2edb3606fa49eab2ba92fba460d33196e8e6acb209f7c6d4` | 74223 | 26438 | 22670 |
| `lyon` (pinned `lyon_tessellation = "=1.0.23"`, `lyon_path = "=1.0.19"`) | `54c8fd0b62bf9806dab17819f4580a5b520fcc7445a850727fef06879a2684cf` | 196415 | 68011 | 57923 |
| Delta (lyon − internal) | — | +122192 | +41573 | +35253 |

Both hashes are unchanged from the prior receipt: the only source change
in this revision is in the test/script/doc layer (see the fix commit
above), not in the measured `experiments/drawing-comparison` crate
itself, so re-running the same pinned-Lyon source reproduces the same
artifact bytes — this is stated plainly rather than silently re-using an
old number.

Command (requires a clean tracked tree; builds both backends itself with
`cargo build --release --locked --target wasm32-unknown-unknown`,
records the actual `git rev-parse HEAD`/`rustc --version`/`cargo
--version` it ran with, and cross-checks each WASM workload's returned
checksum against the equivalent `cargo run --locked` native driver's
`total_vertices` before reporting anything — this run's native/WASM
checksums were internal `1330`/`1330` and lyon `870`/`870`, both equal):

```sh
node scripts/compare-drawing.mjs
```

Output (this run): `test-results/drawing-comparison.json`, SHA-256
`6d200bf04113891eb160435fc21e2e4a3697ba4badb9192782118f3344a28928`.

## 2. Correctness tolerances (equal bounded workload, not pixel-exact)

| Shape | Tolerance (enforced; `checkAreaTolerances` throws if exceeded) | Agreement |
| --- | ---: | --- |
| Rectangle fill area | 0% (exact) | Exact (both are two-triangle quads) |
| Triangle fill area | 0% (exact) | Exact (both are a single filled triangle) |
| Circle fill area (radius 20, 20 segments) | 3% | 1.92% difference (Lyon's adaptive arc approximation vs. this companion's fixed-segment fan) |
| Stroked cubic curve area (tolerance 0.5, thickness 2.0) | 1% | 0.10% difference (different flattening/stroking algorithm, butt caps both sides) |

No join, cap, or dash-pattern parity is claimed; see
[docs/drawing-companion.md](../drawing-companion.md#comparison-evidence-and-artifact-receipt)
for the per-shape method.

## 3. Paired runtime (5 repeats each, Node WebAssembly, not a browser)

| Backend | Samples (ms) | Median (ms) |
| --- | --- | ---: |
| `internal` | 0.7094, 0.1277, 0.1240, 0.1141, 0.1145 | 0.1240 |
| `lyon` | 2.5498, 0.3817, 0.3444, 0.4932, 0.4157 | 0.4157 |

**Classification: `inconclusive`.** The first sample of each backend is
a cold-start/JIT-warmup outlier roughly 10x the rest; excluding it would
require changing the measurement method after seeing the data, so it is
reported as-sampled. This is **not** a GPU frame-time or upload
measurement — neither backend touches a GPU in this comparison, only
CPU-side tessellation into a `Vec<Vertex>`/`Vec<u16>`. **No speed,
throughput, or SLO claim is made for either backend on this shared,
non-dedicated host.**

## 4. GPU release proof (real browser, not simulated)

Fixture exports (`companions/draw/examples/showcase.rs`, app-specific,
not a core ABI change): `request_gpu_release()`, `resources_live()`,
`request_empty_frame()`, `empty_frames_processed()`. Updated showcase
artifact:
`companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm`,
raw 219073 / gzip-9 67870 / brotli-11 56745 bytes, SHA-256
`6059c3bccec33c2aff1c1ebd528a80f799876a97168c73b34594ed641edd7d26`
(`cargo build --release --locked --target wasm32-unknown-unknown`).

Command:

```sh
cargo build --release --locked --target wasm32-unknown-unknown \
    --manifest-path companions/draw/Cargo.toml --example showcase
DRAWING_QUALIFICATION_PORT=4280 node node_modules/.bin/playwright test \
    --config experiments/drawing-comparison/playwright.config.mjs
```

Result (this run): **27 passed, 0 failed, 0 skipped, 0 flaky** —
chromium/firefox/webkit, 9 tests each: render, resize, empty-batch,
clip, opacity, draw-order, GPU-release, device pixel ratio 1, device
pixel ratio 2 (the DPR cases use `test.use({ deviceScaleFactor })`
inside the spec itself, run on all three engines, not a
Chromium-only/project-level hack).
`{"startTime":"2026-11-11T08:31:03.993Z","duration":41956.811,"expected":27,"skipped":0,"unexpected":0,"flaky":0}`.
Full JSON reporter output: `test-results/drawing-browser-qualification.json`,
SHA-256 `ea364bb053677adfa6857af780aead7c7f75bb26d2c9df4587a2255bd468e887`.

GL object liveness is tracked by identity (a `Set` of the actual
`WebGLBuffer`/`WebGLShader`/`WebGLProgram` objects, not a call counter)
via `page.addInitScript`-installed wrappers around
`WebGLRenderingContext.prototype.{create,delete}{Buffer,Shader,Program}`.
The GPU-release test asserts: exactly one live program, exactly two live
buffers, and zero live shaders before release; after
`request_gpu_release()`, all three live counts are `0`, every created
object of each kind was deleted exactly once (`create === delete`), no
new program was created by the release itself, there are zero
duplicate/unknown deletes, and a second release request is a no-op
(idempotent, and the runtime's frame counter is shown still advancing
afterward).

## 5. External consumer render proof (real browser, public API only)

Fresh crate `experiments/drawing-comparison/external-consumer`
(`drawing-external-consumer`) depends on `miniquad-draw` via a path
dependency (the equivalent of a pinned Git dependency before a
crates.io release); no source copied. `examples/consume.rs` draws one
rectangle and one circle using only the companion's public
`Batch`/`Color`/`Rect`/`Renderer`/`Transform2D` API.

Commands:

```sh
cargo build --release --locked --target wasm32-unknown-unknown \
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
  time, upload time, or GPU timing measurement for either backend, and
  no timing improvement, SLO, or throughput claim is made anywhere in
  this document.
- Correctness equivalence is area-based and tolerance-bound (0% for
  rectangles/triangles, 3% for circles, 1% for stroked curves — see
  section 2), not pixel-exact; it does not cover join/cap/dash parity.
- DPR 1/DPR 2 were exercised on Chromium, Firefox, and WebKit alike
  (`test.use({ deviceScaleFactor })` in the spec itself); this does not
  extend to any claim about mobile Safari/WebKit, since this WebKit is
  the desktop engine Playwright pins on macOS, not a real mobile device.
- Native-platform window rendering was not verified for either
  `companions/draw` or the external consumer in this receipt; a
  successful `wasm32-unknown-unknown`/native `cargo build`/`cargo check`
  is not evidence of a native window ever opening or rendering a frame.
- All measurements were taken on one shared, non-dedicated development
  machine, not a dedicated or isolated benchmark host.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
