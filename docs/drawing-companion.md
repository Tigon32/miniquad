# Drawing companion: a bounded optional 2D batch-geometry package

* Date: 2026-11-11
* Scope: `companions/draw/` (the `miniquad-draw` crate) and this guide
* Related issue: [#123](https://github.com/Tigon32/miniquad/issues/123)
* Related decision: MADR 0009 — "Keep browser adoption tools outside the core library" (proposed). Read from `docs/adr/0009-optional-browser-adoption-layer.md` at commit `87e8e50` on another branch; this ADR is not yet present on `feat/drawing-companion` and so is not linked here, to keep `node scripts/check-docs.mjs` passing. It drafted the optional-package boundary this crate fills.
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

## Selection rationale: narrow adapter vs. a maintained tessellation library

Issue #123 requires comparing this package's own implementation against a
maintained drawing/tessellation library before selecting an approach.

| Dimension | `miniquad-draw` (this crate) | A maintained tessellation library (for example `lyon`) |
| --- | --- | --- |
| Scope | Bounded: triangles, axis-aligned rectangles, thick polylines with butt caps, circles, cubic curves with bounded adaptive subdivision | Broad: general polygon fill (even-odd/non-zero), miter/round/bevel joins, dashed strokes, arbitrary path construction |
| Dependencies added | Zero beyond `miniquad` (path dependency) | One or more crates (tessellation, geometry types), pulled into any project that selects this package |
| API surface | Narrow, five geometry builders plus a batch and a GPU adapter | Much larger path/tessellator API; a project typically also writes its own GPU upload and batching layer |
| Maintenance status | New code in this repository; this guide is the only maintenance record so far | Actively maintained upstream project with its own release history (not independently re-verified for this review; see Limits) |
| Fit to the existing `RenderingBackend` | Built directly against the trait reviewed in `src/graphics.rs` (vertex/index buffers, `PipelineParams`, `apply_scissor_rect`) | Would need a separate integration layer to turn tessellator output into `miniquad` buffers and pipelines; not part of the library itself |
| Antialiasing | None. Edges are hard; no coverage-based or MSAA-aware stroke/fill | Depends on the chosen tessellator and renderer integration; some projects add MSAA or signed-distance-field strokes |

**Decision:** keep the narrow, in-repository adapter for this first
version. The bounded scope (five geometry kinds, explicit validation
errors, deterministic curve termination) is small enough to unit test
completely and to keep dependency-free, which issue #123 and MADR 0009
both require ("Keep Miniquad core small", "no drawing-layer dependencies
to applications that do not select it"). A maintained tessellation
library remains a reasonable later option if a project needs concave
polygon fill, line joins, or dashed strokes that this package does not
provide; that step was out of scope here and is not implemented.

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

## Limits (state clearly, no unverified claims)

* **No benchmark or maintenance comparison was run.** This guide does not
  claim `miniquad-draw` is faster, smaller, or better maintained than any
  external library. No artifact-size or frame-time measurement was taken
  for either option. A later MADR or issue should do that work if a
  performance or size claim is needed; see MADR 0009's own instruction
  not to report a memory or performance improvement without
  measurements.
* **Browser rendering was verified once, in Chromium only**, via a
  temporary, session-local harness (see the "Fixed: real-browser
  rendering regression" section above): `gl.getError()` is clean and the
  canvas shows 89+ distinct colors across a running showcase, clearing
  the parent's `colors.size > 8` assertion. Firefox, WebKit, resize/DPI
  behavior, and input were not exercised this way; the parent's own
  `tests/browser/drawing.spec.mjs` run is the authoritative check.
  Native-platform rendering was still not verified: this package was
  checked and tested with `cargo test` (host, macOS) and
  `cargo check`/`cargo build --release` for `wasm32-unknown-unknown`, but
  no pixel was observed in a real native window.
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
test (the `lib.rs` quick example) also passed.

Not run here (blocked or explicitly out of scope for this change):

* Browser pixel, resize, DPI, and input tests (see the Browser
  reproduction skill; the parent owns this once the showcase shader is
  confirmed to run).
* Native-platform frame tests on an actual OS window.
* Any performance or artifact-size measurement (see Limits).

## Build and check commands used

```sh
cargo test --manifest-path companions/draw/Cargo.toml
cargo check --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --lib
cargo build --release --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --example showcase
```

All three passed locally (`wasm32-unknown-unknown` installed via
`rustup target add wasm32-unknown-unknown`).

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
