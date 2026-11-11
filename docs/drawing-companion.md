# Drawing companion: a bounded optional 2D batch-geometry package

* Date: 2026-11-11
* Scope: `companions/draw/` (the `miniquad-draw` crate) and this guide
* Related issue: [#123](https://github.com/Tigon32/miniquad/issues/123)
* Related decision: [MADR 0009 — Keep browser adoption tools outside the core library](adr/0009-optional-browser-adoption-layer.md) (proposed).
* Source reviewed: `Tigon32/miniquad`, branch `feat/drawing-companion`, built on `454792c46febefc476e1df153a5efed8bbb2ef79`
* Writing review: **STE-aligned draft**. Full dictionary review not done.

## Problem

Miniquad supplies a GPU rendering interface (`RenderingBackend` in
`src/graphics.rs`). It does not supply a Canvas 2D-style path API. The
`quad` and `instancing` examples show that even a small animated shape
needs its own vertices, indices, a texture, a shader, a pipeline, and
bindings. Issue #123 asks for a small optional package that draws
transforms, lines, filled triangles or simple polygons, circles, and
cubic curves, with explicit color, clipping, and reusable batches,
without adding a dependency to the Miniquad core crate or to
applications that do not select this package.

## Ownership and package boundary

Use the [drawing starter recipe](browser-starter-drawing.md) to add this
package to a generated external browser project without copying its implementation.

`companions/draw/` is a **standalone Rust crate**. It is not a Cargo
workspace member of the root `miniquad` crate and the root `Cargo.toml`
is not changed. It depends on `miniquad` by path (`../../`), the same way
an external application would depend on a published `miniquad` version.
It adds **no other external dependency**. The core dependency graph (the
root crate's `Cargo.toml` and `Cargo.lock`) is unchanged by this package.

This matches the MADR 0009 resource-ownership table: "Drawing batches and
GPU buffers" are owned by the optional drawing package, with "Explicit
package cleanup" as the release action. This guide and the crate
implement that cell of the table.

## Public interface

```text
miniquad_draw::
  color::Color            straight-alpha RGBA color
  transform::Transform2D  2D affine transform (scale, rotate, translate, compose)
  geometry::              pure geometry builders (no GPU state):
    triangle, rectangle, polyline, circle,
    flatten_cubic_bezier, cubic_curve_stroke
    GeometryError, Rect, Vertex
  batch::Batch            accumulates geometry in submission order,
                           grouped into clip-rectangle chunks
  gpu::Renderer           the only part that touches
                           `miniquad::RenderingBackend`: owns its shader,
                           pipeline, and dynamic vertex/index buffers
```

A caller builds a `Batch` each frame (or reuses one with `Batch::clear`),
pushes shapes, and calls `Renderer::draw(ctx, &batch, target_size)`.
`Renderer::new` and `Renderer::destroy` are explicit: the renderer is not
dropped automatically, because releasing miniquad GPU resources needs
`&mut dyn RenderingBackend`.

## Coordinate, DPI, and alpha conventions

* **Coordinate space.** All public geometry functions take **logical
  pixels in a top-left-origin, Y-down space**: `(0, 0)` is the top-left
  corner and `y` grows downward. This matches common 2D drawing APIs and
  the glossary's "Canvas 2D-style path API" framing in issue #123. It is
  **not** the same space as Miniquad clip space (`[-1, 1]`, Y-up), which
  `gpu::Renderer` converts to internally.
* **Target size and DPI.** `Renderer::draw` takes an explicit
  `target_size: (f32, f32)` in the same pixel units as the geometry the
  caller pushed. A caller that wants native-resolution drawing under
  `conf.high_dpi = true` should pass the same pixel size it used to build
  the geometry (for example, `window::screen_size()`, which already
  returns the DPI-scaled size per `src/conf.rs`). This package does not
  read `window::screen_size()` or `window::dpi_scale()` itself, so it
  stays testable without a window and composes with any render target
  size a host chooses (full canvas, a sub-region, or an offscreen
  texture).
* **Clip rectangles.** Clip rectangles use the same top-left-origin,
  Y-down space as geometry. `gpu::Renderer` converts a clip rectangle to
  the scissor rectangle `RenderingBackend::apply_scissor_rect` expects.
  That contract was confirmed by reading `src/graphics/gl.rs`, which
  forwards `(x, y, w, h)` straight to `glScissor` (bottom-left origin,
  Y-up), and `src/graphics/metal.rs`, which flips the same input against
  the active pass height to match Metal's native top-left, Y-down
  scissor rectangle. `gpu::apply_clip` performs the matching flip before
  calling `apply_scissor_rect`.
* **Alpha.** The public `Color` type is **straight alpha**: `Color::new(r,
  g, b, a)` keeps its plain meaning and `a = 0` is fully clear.
  `Color::to_premultiplied` converts to premultiplied channels before a
  vertex is built. `gpu::Renderer` uses a **premultiplied-alpha blend**
  (`color_blend: (One, OneMinusValue(SourceAlpha))`,
  `alpha_blend: (Zero, One)`), the same pattern documented on
  `PipelineParams::alpha_blend` in `src/graphics.rs` for avoiding
  unwanted blending with a WASM canvas's host page background. Two
  reasons drove premultiplied alpha over the alternative (straight alpha
  with a standard `(SourceAlpha, OneMinusSourceAlpha)` blend): batches can
  draw many overlapping translucent shapes in one frame, and
  premultiplied blending composites predictably when shapes overlap,
  without a separate "unmultiply" step.

## Comparison evidence and artifact receipt

This section was rewritten after an actual pinned-Lyon benchmark build
(previously this guide only recorded Lyon's license/version metadata and
explicitly disclaimed any WASM build or measurement — see git history for
that earlier text). The new evidence below is real: both backends were
compiled, run, and measured from
`experiments/drawing-comparison` (a benchmark-only crate, never a
dependency of `companions/draw` or any production package — see
`experiments/drawing-comparison/Cargo.toml`'s mutually-exclusive
`internal`/`lyon` features).

**Source verification (real, re-checked this session).** At pinned
version `lyon_tessellation = "=1.0.23"` / `lyon_path = "=1.0.19"`
(fetched from crates.io via `cargo generate-lockfile` inside
`experiments/drawing-comparison`, recorded in its tracked `Cargo.lock`):
license `MIT OR Apache-2.0`, repository `https://github.com/nical/lyon`,
default feature `std`, direct dependencies `lyon_path`, `num-traits`,
`float_next_after`. This matches the prior unverified claim in this
document's earlier revision.

**WASM build (new: both sides now proven to compile for the browser
target).**

```sh
cargo build --release --target wasm32-unknown-unknown \
    --no-default-features --features internal --lib \
    --manifest-path experiments/drawing-comparison/Cargo.toml \
    --target-dir experiments/drawing-comparison/target-internal
cargo build --release --target wasm32-unknown-unknown \
    --no-default-features --features lyon --lib \
    --manifest-path experiments/drawing-comparison/Cargo.toml \
    --target-dir experiments/drawing-comparison/target-lyon
```

Both commands passed against core `miniquad`/`companions/draw` baseline
`f837a98d415262320a8c66ef9f8024d8f2faeab1` (not itself modified; the
benchmark crate, tests, and this doc are new/changed on top of it — see
the exact fixture-commit SHA recorded in
`docs/performance-evidence/2026-11-11-drawing-companion-comparison.md`),
macOS arm64, `rustc 1.99.0`, `wasm32-unknown-unknown` via `rustup target
add`. `node scripts/compare-drawing.mjs` builds both backends itself
(`cargo build --release --locked --target wasm32-unknown-unknown`, from
a clean tracked tree — it refuses to run otherwise) before measuring, so
a stale, hand-built artifact can never be reported. Real artifact sizes
and hashes (gzip at `zlib` level 9, Brotli at quality 11):

| Backend | Raw bytes | gzip bytes | Brotli bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| internal (`miniquad-draw` geometry only, no GPU upload) | 74223 | 26438 | 22670 | `6789c35ee301882e2edb3606fa49eab2ba92fba460d33196e8e6acb209f7c6d4` |
| lyon (pinned `lyon_tessellation` 1.0.23 adapter) | 196415 | 68011 | 57923 | `54c8fd0b62bf9806dab17819f4580a5b520fcc7445a850727fef06879a2684cf` |

These are the comparison crate's own CPU-only geometry/tessellation
artifacts (`experiments/drawing-comparison/src/{internal,lyon_adapter}.rs`),
**not** the showcase example, and **not** a GPU-upload or frame-time
measurement — neither side uploads anything to a GPU in this comparison.
At brotli, the pinned Lyon adapter is **35253 bytes larger** than the
internal path (57923 vs 22670), on this one bounded workload and this one
target profile (`opt-level` as set by `[profile.release]`, if any, or
cargo's default release profile — this repository's root
`Cargo.toml`/workspace profile applies to both builds identically, since
both crates build through the same `cargo build --release` invocation
family).

**Equal bounded reference workload**
(`experiments/drawing-comparison/src/workload.rs`): 50 rectangles, 50
triangles, 20 circles (radius 20, both sides using 32 segments), and 10
stroked cubic curves (tolerance 0.5, thickness 2.0), built once per
backend from identical input coordinates/colors.

**Correctness, with explicit, enforced tolerances (no pixel-parity
claim).** Lyon's fill/stroke tessellation algorithms differ fundamentally
from the internal fixed-segment/butt-cap implementation (documented in
`experiments/drawing-comparison/src/lyon_adapter.rs`), so exact
triangle-count or pixel parity is **not** claimed. `checkAreaTolerances`
in `scripts/compare-drawing.mjs` computes each shape's relative area
difference and checks it against a fixed per-shape tolerance
(`AREA_TOLERANCE`); `node scripts/compare-drawing.mjs` throws (nonzero
exit) if any shape exceeds its tolerance, so this table cannot silently
go stale:

| Shape | Tolerance | Internal area (sum) | Lyon area (sum) | Observed difference |
| --- | ---: | ---: | ---: | ---: |
| Rectangles (50) | 0% (exact) | 14000.0 | 14000.0 | exact (both are simple convex axis-aligned fills) |
| Triangles (50) | 0% (exact) | 8100.0 | 8100.0 | exact (both are simple convex fills) |
| Circles (20, r=20) | 3% | 24971.572469653038 | 24491.760360374697 | 1.92% (Lyon's circular-arc tessellation vs. the internal fixed-segment polygon) |
| Stroked curves (10) | 1% | 1915.4326597578356 | 1917.3037460932273 | 0.10% (adaptive-subdivision flattening tolerance differs slightly between the two stroke builders) |

Total vertex count: internal 1330, Lyon 870 (different triangulation
strategies; not a correctness defect on either side, and not comparable
as a "verbosity" metric since the two tessellators are not required to
produce the same mesh for the same input). Both counts are also each
backend's exported WASM `run()` checksum; `compare-drawing.mjs` cross-
checks this native count against the value the compiled WASM module
actually returned and throws if they differ, so a checksum match is
real cross-runtime evidence the WASM build executed the same workload
as the native one, not merely that it returned *some* non-zero number.

**Paired runtime (Node's `WebAssembly`, 5 alternating repeats per the
Performance proof skill, median reported, classification by sample-range
overlap — see `scripts/compare-drawing.mjs`'s `classifyRuntime`).**
One representative run on this shared macOS host, Node v26.10.0:
internal median 0.048 ms, Lyon median 0.141 ms per workload call,
classification **`"inconclusive"`** (the two `[min, max]` sample ranges
overlapped, driven by a JIT warm-up outlier on an early repeat — see
`test-results/drawing-comparison.json`, regenerated by
`node scripts/compare-drawing.mjs`, not committed). Per the Performance
proof skill: **do not read this as a measured speed win for either
side.** This is also a Node `WebAssembly` runtime measurement, not a
browser frame time, and not a GPU timing — see the browser qualification
evidence below for the one pixel/GPU-release measurement this issue does
make in a real browser.

**Reproduce:**

```sh
node scripts/compare-drawing.mjs            # 5 repeats (default)
node scripts/compare-drawing.mjs 5          # explicit repeat count
```

The command requires a clean tracked tree (`git status --porcelain
--untracked-files=no` must be empty) and builds both backends itself
with `--locked`, so it never measures a stale or hand-edited artifact;
it also records the exact `git rev-parse HEAD`, `rustc --version`, and
`cargo --version` it ran with in the receipt.

Unit tests for the script's pure helpers (`median`, `classifyRuntime`,
`measureArtifact`, `checkAreaTolerances`) live in
`tests/drawing-comparison.test.mjs`
(`node --test tests/drawing-comparison.test.mjs`; 13 passed). The
artifact-measurement tests use hermetic temporary fixtures (a minimal
valid WASM header) and a missing-file rejection case; they do not
require or skip on a prebuilt benchmark artifact.

**Why this stays benchmark-only.** `lyon_tessellation`/`lyon_path` are
pinned, exact-version dependencies of `experiments/drawing-comparison`
only (`=1.0.23`/`=1.0.19` in that crate's `Cargo.toml`); neither
`companions/draw` nor any production package depends on Lyon. This
matches the explicit scope approval for this change: "Approve
benchmark-only dependencies ... for pinned Lyon and block-mesh only in
isolated bench projects, never core or production companions."


## Selection rationale: narrow adapter vs. a maintained tessellation library

Issue #123 requires comparing this package's own implementation against a
maintained drawing/tessellation library before selecting an approach.

| Dimension | `miniquad-draw` (this crate) | A maintained tessellation library (for example `lyon`) |
| --- | --- | --- |
| Scope | Bounded: triangles, axis-aligned rectangles, thick polylines with butt caps, circles, cubic curves with bounded adaptive subdivision | Broad: general polygon fill (even-odd/non-zero), miter/round/bevel joins, dashed strokes, arbitrary path construction |
| Dependencies added | Zero beyond `miniquad` (path dependency) | One or more crates (tessellation, geometry types), pulled into any project that selects this package |
| API surface | Narrow, five geometry builders plus a batch and a GPU adapter | Much larger path/tessellator API; a project typically also writes its own GPU upload and batching layer |
| Maintenance status | New code in this repository | Repository is not archived; observed upstream activity on 2026-11-05. This is not a maintenance guarantee. |
| Fit to the existing `RenderingBackend` | Built directly against the trait reviewed in `src/graphics.rs` (vertex/index buffers, `PipelineParams`, `apply_scissor_rect`) | Would need a separate integration layer to turn tessellator output into `miniquad` buffers and pipelines; not part of the library itself |
| Antialiasing | None. Edges are hard; no coverage-based or MSAA-aware stroke/fill | Depends on the chosen tessellator and renderer integration; some projects add MSAA or signed-distance-field strokes |

**Decision:** keep the narrow, in-repository adapter as the default for
this companion. This change's benchmark confirms the earlier reasoning
with real numbers rather than overturning it: at brotli, the pinned Lyon
adapter is 35253 bytes larger on the bounded reference workload above,
and the paired runtime comparison came back inconclusive (see above) —
neither a measured size nor speed win justifies replacing the bounded,
dependency-free implementation for the shapes it already covers
(triangles, axis-aligned rectangles, circles, thick polylines, cubic
curves). The bounded scope (five geometry kinds, explicit validation
errors, deterministic curve termination) is small enough to unit test
completely and to keep dependency-free, which issue #123 and MADR 0009
both require ("Keep Miniquad core small", "no drawing-layer dependencies
to applications that do not select it"). A maintained tessellation
library remains a reasonable later option if a project needs concave
polygon fill, line joins, or dashed strokes that this package does not
provide — Lyon's own fill/stroke tessellators clearly support those
(see `experiments/drawing-comparison/src/lyon_adapter.rs`); that
integration work is still out of scope for this companion and is not
implemented here.

## Fixed: real-browser rendering regression (invisible canvas)

The parent integrated the initial version of this package and ran the
`showcase` example in a real Chromium browser (`tests/browser/drawing.spec.mjs`,
parent-owned). The test failed: the canvas advanced past frame 2, but a
screenshot contained exactly one color (the clear color composited with
the host page), failing the parent's `colors.size > 8` assertion. This
section documents the root cause and the fix, both entirely within
`companions/draw/**`.

Two independent bugs stacked to produce "canvas shows nothing":

1. **The index buffer used `u32` indices on a WebGL 1 context.**
   `conf::Conf`'s default `platform.webgl_version` is `WebGL1`, and the
   default WebGL 1 context has no `u32` element-index support without
   the `OES_element_index_uint` extension (which this package did not
   request). Drawing with an unsupported index type raises
   `GL_INVALID_ENUM` and **draws nothing**, silently. A temporary,
   instrumented build (reading `gl.getError()` after each GPU call)
   isolated the error to the `ctx.draw(...)` call itself, not pipeline
   or shader setup. Fix: `gpu::Renderer`'s index buffer now holds `u16`
   indices. `batch::Batch` enforces a new `MAX_CHUNK_VERTICES` (`1 <<
   16`) bound per chunk — a same-clip run of shapes that would overflow
   a `u16` index range now starts a new chunk (still with the same
   clip, so draw order and the painter's-algorithm contract are
   unaffected) instead of growing one chunk past what a `u16` index can
   address. The conversion from a shape's own (small, always
   `u16`-representable) local index to the chunk's rebased index uses
   `u16::try_from(...).expect(...)`, not an `as` truncation, so a future
   bound regression panics instead of silently drawing wrong geometry.
2. **The default pass clear used `PassAction::default()`**, which clears
   alpha to `0.0`. This package's blend state (`gpu::blend_params`)
   intentionally never *writes* a new alpha — it only protects
   whatever alpha is already in the framebuffer, by design (`Zero, One`
   on the alpha channel), so overlapping translucent draws do not punch
   holes in an already-opaque canvas. That design requires the clear to
   already be opaque; `PassAction::default()` violates that
   precondition, so the canvas alpha stayed `0.0` for the whole frame.
   On the WASM build, a `premultipliedAlpha: true` WebGL canvas (the
   default; `js/gl.js` passes no explicit context attributes) composites
   an alpha-`0.0` pixel as fully transparent, so the browser shows the
   host page background, not the drawn colors. Fix: the `showcase`
   example's `begin_default_pass` now clears with an explicit opaque
   alpha (`PassAction::clear_color(0.08, 0.08, 0.1, 1.0)`).

Bug 1 alone was enough to hide all drawn geometry (nothing ever reached
the framebuffer); bug 2 alone was enough to hide an opaque background
behind the host page. Both had to be fixed for the showcase to render.

**Regression evidence.** A temporary, session-local reproduction harness
(outside this repository, never committed) mounted the built
`showcase.wasm` through the parent's own `js/miniquad.mjs` /
`runtime.mjs` / `runtime.html` / `gl.js` (read only, unmodified) in
headless Chromium, waited past frame 5, and read back the `#glcanvas`
pixels and `gl.getError()`:

| Build | `gl.getError()` | Distinct colors (480x320 canvas) |
| --- | --- | --- |
| Before this fix | `1280` (`GL_INVALID_ENUM`) | 1 (`#ffffffff`, the host page background) |
| After this fix | `0` | 89–93 (varies slightly frame-to-frame with the animated points) |

This clears the parent's `colors.size > 8` threshold. Only Chromium was
exercised this way; Firefox and WebKit, resize/DPI behavior, and input
remain the parent's stated responsibility (see the Browser reproduction
skill), now unblocked.

## GPU resource release and real-browser qualification (issue #123)

After adding the exports and QC panels below, the showcase artifact is
`companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm`:
raw 219073 bytes, gzip9 67870 bytes (`zlib` level 9), brotli11 56745
bytes (quality 11), SHA-256
`6059c3bccec33c2aff1c1ebd528a80f799876a97168c73b34594ed641edd7d26`
(`cargo build --release --locked --target wasm32-unknown-unknown
--example showcase`, fixture commit
`ae7c8556ef7893558b0532851eb47083c57873ee`).

**GPU release proof fixture.** `companions/draw/examples/showcase.rs`
now exposes three `extern "C"` exports, app-specific to this showcase
(not
a core miniquad ABI change):

* `request_gpu_release()` — a one-shot request (an `AtomicBool`, no raw
  global pointer) that the next `draw()` call consumes exactly once: it
  `.take()`s the `Option<Renderer>`, calls `Renderer::destroy(ctx)`, and
  thereafter renders only a defined clear frame (never a crash, freeze,
  or further scene draw).
* `resources_live()` — returns `1` while the `Renderer` is live, `0`
  once destroyed (an `AtomicU32`), so a host page can assert the release
  actually happened instead of trusting JS-side bookkeeping alone.
* `request_empty_frame()` — switches the renderer into a *persistent*
  empty-`Batch` mode (zero chunks every frame, not a one-shot flag),
  proving `Renderer::draw` does not panic or issue a zero-length draw
  call on an empty batch across many consecutive frames, not just one.
* `empty_frames_processed()` — returns the count of frames rendered
  since `request_empty_frame()` was called (an `AtomicU32`), so a host
  page can assert the empty-frame mode is actually still advancing, not
  stalled after the first frame.

**Browser harness.** This session built its own, isolated Playwright
harness, never the parent's `tests/browser/serve.mjs` / root
`playwright.config.mjs` (port 4173):

* `experiments/drawing-comparison/serve-drawing.mjs` — a static file
  server on port 4280 (override with `DRAWING_QUALIFICATION_PORT`)
  serving the repository's existing, unmodified `js/gl.js`,
  `js/miniquad.mjs`, `js/runtime.html`, `js/runtime.mjs`,
  `js/host-preferences.mjs`, this session's own
  `tests/browser/drawing-qualification.html`, and this session's own
  built `companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm`.
* `experiments/drawing-comparison/playwright.config.mjs` — an
  independent config (`testMatch: "drawing.spec.mjs"`,
  `MINIQUAD_BROWSER=chromium|firefox|webkit` to select one engine,
  default all three). DPR 1 and DPR 2 are **not** separate Chromium-only
  projects: `tests/browser/drawing.spec.mjs` runs its "device pixel
  ratio 1"/"device pixel ratio 2" cases as two `test.describe` blocks
  using Playwright's `test.use({ deviceScaleFactor })`, so the same
  config and the same spec file run unmodified under the root
  `playwright.config.mjs` once the parent integrates the
  `/drawing-qualification` route (see "Root integration" below) —
  nothing in the spec depends on this session's private project
  metadata or a project-name-based skip.

**Real evidence from `tests/browser/drawing.spec.mjs` (own run, this
session, macOS, headless, fixture commit
`ae7c8556ef7893558b0532851eb47083c57873ee` on top of core baseline
`f837a98d415262320a8c66ef9f8024d8f2faeab1`):**

```sh
# from the repository root
ln -s /path/to/parent-checkout/node_modules node_modules   # or npm ci
cargo build --release --locked --target wasm32-unknown-unknown \
    --manifest-path companions/draw/Cargo.toml --example showcase
DRAWING_QUALIFICATION_PORT=4280 node node_modules/.bin/playwright test \
    --config experiments/drawing-comparison/playwright.config.mjs
```

| Engine | Tests | Result |
| --- | --- | --- |
| chromium | 9 (render, resize, empty batch, clip, opacity, draw order, GPU release, DPR 1, DPR 2) | **9 passed** |
| firefox | same 9 | **9 passed** |
| webkit | same 9 | **9 passed** |

**27 passed, 0 failed, 0 skipped, 0 flaky**, one combined run across all
three engines (JSON reporter output saved at
`test-results/drawing-browser-qualification.json`, not committed — see
its SHA-256 in
`docs/performance-evidence/2026-11-11-drawing-companion-comparison.md`).
Each test asserts zero `pageerror`/console-error events in addition to
its pixel or counter checks.

What each test actually checks (interior pixels only, away from any
anti-aliased edge — hard edges are the documented antialiasing limit
below, so no pixel-parity claim is made at a shape boundary):

* **Clipping** — `Batch::set_clip` restricts an overlay rectangle to its
  left half; the right half keeps the unclipped base color.
* **Opacity** — a 50%-alpha overlay over an opaque base blends to the
  expected `over`-compositing color within a 2/255 per-channel
  tolerance (a flat interior pixel, not an edge: the tolerance covers
  only 8-bit rounding/premultiplied-alpha rounding error).
* **Draw order** — two identical, fully opaque, overlapping rectangles;
  only the later (top) color is visible.
* **Empty batch** — `request_empty_frame()` switches the renderer into a
  *persistent* empty-batch mode (not a one-shot flag); the test polls
  the exported `empty_frames_processed()` counter past zero and then
  past that value again (proving frames keep advancing while empty, not
  just that one frame was consumed), then screenshots the canvas and
  asserts every pixel equals the clear color (exactly one distinct
  color) within a 2/255 per-channel tolerance.
* **GPU release** — before release, `resources_live() === 1`, exactly
  one *live* GL program and exactly two *live* GL buffers exist (not
  just "at least"), and zero live shader objects (shader objects are
  deleted at link time). Liveness is tracked by identity (a `Set` of the
  actual `WebGLBuffer`/`WebGLShader`/`WebGLProgram` objects returned by
  `gl.create*`, not a call counter), via `page.addInitScript`-installed
  wrappers around `WebGLRenderingContext.prototype.{create,delete}{Buffer,Shader,Program}`
  that also flag a delete of an object that was never live or already
  deleted (`duplicateOrUnknownDeletes`). After
  `request_gpu_release()`, every live object count is `0`, every
  created object was deleted exactly once (`create === delete` per
  kind), no new program was created by the release itself, and there
  are zero duplicate/unknown deletes. A second release request is a
  no-op (idempotent): the full GL-tracking snapshot is byte-for-byte
  unchanged, while the runtime's frame counter keeps advancing (proving
  the second request did not freeze the runtime).
* **DPR 1 and DPR 2** — `devicePixelRatio` inside the runtime iframe
  equals the configured ratio; the canvas's *physical* backing-store
  width/height (the `<canvas>` element's `width`/`height` attributes,
  not its CSS size) equals `cssSize * ratio` exactly, and the captured
  screenshot's own pixel dimensions match that same physical size — not
  just "some non-trivial content exists" at an unverified size.

**Investigated, no defect found: `delete_shader` and compiled shader
objects.** The task that produced this change asked whether root
`src/graphics/gl.rs`'s `delete_shader` might not delete compiled shader
objects. On inspection: `load_shader_internal` already calls
`glDetachShader` + `glDeleteShader` on both the vertex and fragment
shader objects immediately after `glLinkProgram` succeeds — this is the
standard GL pattern (a linked program retains the data it needs; the
shader objects themselves have no further purpose once linked). The
public `delete_shader(ShaderId)` function then only needs to, and does,
call `glDeleteProgram` on the one long-lived object (the linked
program). This is **not a defect**: no core change was made, per this
change's instruction not to make an unrelated core change unless
strictly necessary (it was not).

## Limits (state clearly, no unverified claims)

* **A real pinned-Lyon benchmark was run (issue #123), but it is CPU-only
  and inconclusive on runtime.** See "Comparison evidence and artifact
  receipt" above: both backends' WASM artifact sizes and a correctness
  tolerance table are real and measured; the paired runtime comparison
  came back `"inconclusive"` per the Performance proof skill's
  overlap rule, so **no speed claim is made for either backend**. Neither
  side uploads to a GPU in that comparison; it is not a frame-time or
  GPU-timing measurement.
* **Browser rendering, resize, clipping, opacity, draw order, empty-batch,
  GPU-release, and DPR 1/2 were all verified in real Chromium, Firefox,
  and WebKit** via this session's own isolated Playwright harness (see
  "GPU resource release and real-browser qualification" above): **27
  passed, 0 failed, 0 skipped, 0 flaky**, across all three engines (DPR 1
  and DPR 2 are run on all three engines via `test.use({
  deviceScaleFactor })`, not restricted to Chromium or to a project-level
  hack). The same spec file is designed to run unmodified under the
  root `playwright.config.mjs` once the `/drawing-qualification` route
  is integrated there (see "Root integration needs" at the end of this
  document); this session's own config and port (4280) remain a private
  staging harness until that integration happens, and the parent's own
  pass against the root config after integration remains the
  authoritative final check per this repository's conventions.
  Native-platform rendering was still not verified: this package was
  checked and tested with `cargo test` (host, macOS) and
  `cargo check`/`cargo build --release --locked` for
  `wasm32-unknown-unknown`, but no pixel was observed in a real native
  window — **do not read any part of this issue's evidence as a native
  window-rendering claim.**
* **This is a single, shared, non-dedicated macOS host, not a dedicated
  benchmark machine.** No timing improvement, SLO, or throughput claim is
  made anywhere in this document beyond the explicitly labeled,
  `"inconclusive"`-classified runtime comparison above; a WebKit
  (desktop Safari engine) pass on macOS is also not evidence for any
  mobile Safari/WebKit claim.
* **No antialiasing.** Shape edges are hard-edged triangles; this package
  does not implement coverage-based or MSAA-specific antialiasing.
* **Polyline joins are butt caps only.** Adjacent polyline segments are
  independent quads; there is no miter, round, or bevel join at a corner,
  and no dash pattern.
* **Rectangles and triangles only for fills**, not general polygon
  tessellation (no concave n-gon support, no polygon with holes).
* **Clip rectangles are axis-aligned** and applied per draw call
  (`apply_scissor_rect`); there is no nested or rounded-rectangle clip.
* **Bounded inputs.** `geometry::MAX_COORDINATE`,
  `MAX_CIRCLE_SEGMENTS`, `MAX_POLYLINE_POINTS`,
  `MAX_CURVE_SUBDIVISION_DEPTH`, and `batch::MAX_BATCH_VERTICES` reject
  degenerate, non-finite, or oversize input instead of growing memory or
  looping without bound; a caller that needs a larger scene must raise
  those constants in its own fork and re-measure, not assume they scale
  silently.
* **Text is out of scope.** DOM text stays the browser default for
  labels, matching issue #123's acceptance criterion; this package draws
  no glyphs.
* **The optional isometric voxel proof (issue #29)** was not attempted in
  this change: issue #123 explicitly keeps "voxel simulation, general
  scene graphs, physics, and server transport" out of this issue's scope,
  and the showcase example here stays within arrows, curves, a grid, and
  animated points to avoid widening scope toward a game engine or
  networking layer.

## Tests

Pure-geometry unit tests (`cargo test --manifest-path companions/draw/Cargo.toml`)
cover, per module:

* `color`: finite-channel clamping to `[0.0, 1.0]`, **rejection** (not
  silent zeroing) of a non-finite channel via `Color::validate`,
  premultiplication.
* `transform`: identity, translation, scaling, composition order, rejection of
  non-finite input points and non-finite transform fields.
* `geometry`: degenerate shapes (collinear triangle, zero/negative-size
  rectangle, single-point and all-zero-length polylines, too-few/too-many
  circle segments, zero radius), non-finite and oversize coordinates, a
  non-finite color channel rejected at shape-build time (not just at the
  `Color` level), polyline point-count bound, cubic curve termination for
  a fully collapsed (coincident-point) curve and for a tolerance far
  smaller than float precision can resolve (bounded by
  `MAX_CURVE_SUBDIVISION_DEPTH`), and non-finite/non-positive curve
  tolerance.
* `batch`: draw-order preservation and clip-rectangle batching (same-clip
  pushes merge into one chunk; a clip change starts a new chunk; an
  interrupted and later-reused clip value does **not** merge across the
  interruption, so overlapping translucent shapes still draw in
  submission order), atomic rejection (a failed push leaves the batch
  unchanged), invalid-clip rejection that keeps the previous clip, and a
  same-clip run large enough to overflow `MAX_CHUNK_VERTICES` splitting
  into multiple chunks with every index still addressing a vertex within
  its own chunk (the regression test for the real-browser `u16`-index
  fix above).

Observed result: **41 passed, 0 failed** (`cargo test --manifest-path
companions/draw/Cargo.toml`, macOS, local toolchain). A crate-level doc
test (the `lib.rs` quick example) also passed. Adding the
`request_empty_frame`/`request_gpu_release`/`resources_live` exports and
the QC-panel drawing to `examples/showcase.rs` did not change this count
(examples are not covered by the crate's own unit tests; see the browser
qualification section above for their real test coverage).

`tests/drawing-comparison.test.mjs` (`node --test
tests/drawing-comparison.test.mjs`) covers `scripts/compare-drawing.mjs`'s
pure helpers (`median`, `classifyRuntime`, `wasmPath`,
`measureArtifact`, `checkAreaTolerances`), using hermetic temporary
fixtures and a missing-file rejection case rather than a prebuilt
artifact: **13 passed, 0 failed**.

`tests/browser/drawing.spec.mjs`, run against this session's own
isolated harness (see above): **27 passed, 0 failed, 0 skipped, 0
flaky** across chromium/firefox/webkit, including the DPR 1/DPR 2 cases
on all three engines.

Not run here (blocked or explicitly out of scope for this change):

* Native-platform frame tests on an actual OS window (this remains a gap
  for both `companions/draw` and the new `experiments/drawing-comparison`
  external-consumer fixture; only `wasm32-unknown-unknown` and native
  `cargo check`/`cargo test` were exercised).

## Build and check commands used

```sh
cargo fmt --check --manifest-path companions/draw/Cargo.toml
cargo test --lib --manifest-path companions/draw/Cargo.toml
cargo check --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --lib
cargo build --release --locked --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --example showcase
node --test tests/drawing-comparison.test.mjs
node scripts/compare-drawing.mjs
DRAWING_QUALIFICATION_PORT=4280 node node_modules/.bin/playwright test \
    --config experiments/drawing-comparison/playwright.config.mjs
```

All passed locally (`wasm32-unknown-unknown` installed via
`rustup target add wasm32-unknown-unknown`; the Playwright command needs
either `npm ci` in the repository root or a `node_modules` symlink to an
existing parent checkout that already ran it — this session used the
latter and made no `package.json`/`package-lock.json` changes). The
`--locked` flag on the WASM build and on `scripts/compare-drawing.mjs`'s
own internal builds/native runs ensures every measured artifact comes
from the pinned `Cargo.lock` (`lyon_tessellation = 1.0.23`,
`lyon_path = 1.0.19`), not an accidentally newer dependency resolution.

## External consumer qualification (issue #123)

A fresh, separate crate —
`experiments/drawing-comparison/external-consumer`
(`drawing-external-consumer`, `publish = false`) — depends on
`miniquad-draw` the way a downstream project would: a path dependency in
its own `Cargo.toml` (`miniquad-draw = { path = "../../../companions/draw" }`,
the equivalent of a pinned `git = "...", rev = "<sha>"` dependency before
this companion has a public crates.io release — `companions/draw/Cargo.toml`
itself has `publish = false`). No source from `companions/draw` is
copied; `examples/consume.rs` only calls the companion's existing public
`Batch`/`Color`/`Rect`/`Renderer`/`Transform2D` API to draw one rectangle
and one circle.

```sh
cargo check --manifest-path experiments/drawing-comparison/external-consumer/Cargo.toml --example consume
cargo build --release --target wasm32-unknown-unknown \
    --manifest-path experiments/drawing-comparison/external-consumer/Cargo.toml --example consume
node experiments/drawing-comparison/verify-consumer-render.mjs
```

All three passed. The WASM artifact
(`experiments/drawing-comparison/external-consumer/target/wasm32-unknown-unknown/release/examples/consume.wasm`,
208227 bytes, SHA-256
`8ef94fd98f56792c82195bd780e52e59c289de39f70abd96ed9e667b1cc38404`) was
rendered in a real headless Chromium page via
`verify-consumer-render.mjs` (a small, reusable, owned verification
script, not a committed Playwright test): the canvas showed **12 distinct
colors** (more than a flat clear color) and raised **zero** console or
page errors — confirming the external crate actually renders through
`miniquad-draw`'s public API, not just that it compiles.

## Instructions for the parent: running the showcase in a browser

The showcase example (`companions/draw/examples/showcase.rs`) builds a
`wasm32-unknown-unknown` binary the same way `examples/quad.rs` does, but
through the companion crate's own manifest:

```sh
cargo build --release --target wasm32-unknown-unknown \
    --manifest-path companions/draw/Cargo.toml --example showcase
```

This produces
`companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm`.
Load it the same way the repository's existing WASM harness loads
`examples/quad.rs` (see `examples/index.html` and `js/gl.js`): point the
loader at this `.wasm` file instead of the `quad` one, with no change to
the bridge. The showcase draws a grid, two arrows, one sampled cubic
curve, and a field of animated circles entirely with GPU-owned geometry;
it does not draw any DOM text. A host page can place HTML labels over or
beside the canvas, as MADR 0009 expects for the browser adoption layer.

## Root integration needs (left for the parent)

This change stays out of `companions/draw/**`, `experiments/drawing-comparison/**`,
`scripts/compare-drawing.mjs`, `tests/drawing-comparison.test.mjs`,
`tests/browser/drawing.spec.mjs`/`drawing-qualification.html`, and this
doc pair, per its stated scope. To make the 27-case suite above run
against the shared root harness instead of this session's private
port-4280 staging config, the parent still needs to:

* Wire the `/drawing-qualification` route (serving
  `tests/browser/drawing-qualification.html` and the built
  `companions/draw/.../examples/showcase.wasm`) and the `/drawing.wasm`
  static route into the root dev server / `tests/browser/serve.mjs`,
  matching the contract `tests/browser/drawing.spec.mjs` already assumes.
  No change is needed in the spec file itself for this: once the root
  `playwright.config.mjs` also includes `tests/browser/drawing.spec.mjs`
  (a `testMatch` addition is enough), it runs unmodified under
  chromium/firefox/webkit with `test.use({ deviceScaleFactor })` already
  in place — no DPR-specific project configuration is required.
* Add CI invocation for the new Node (`node --test
  tests/drawing-comparison.test.mjs`) and Rust (`cargo test --lib
  --manifest-path companions/draw/Cargo.toml`,
  `cargo fmt --check --manifest-path companions/draw/Cargo.toml`) checks
  to the project's existing pipeline; none of these were added to CI
  config in this change (out of scope per the task).
* Decide whether `scripts/compare-drawing.mjs` should run in CI (it is
  CPU-only and `"inconclusive"` on this host; CI nondeterminism on a
  shared runner could make the runtime comparison noisier still, so this
  change does not recommend gating CI on its runtime classification —
  only on its area-tolerance and checksum checks, which are
  deterministic).
