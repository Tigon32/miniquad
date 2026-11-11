# Browser profiling harness for issue #14

* Tracking: [#14](https://github.com/Tigon32/miniquad/issues/14) (open), background in
  [#12](https://github.com/Tigon32/miniquad/issues/12) and [#15](https://github.com/Tigon32/miniquad/issues/15)
  (both closed, cited here for the SLI/SLO vocabulary).
* Status: **Measurement harness and one recorded run. Not a release qualification and not an
  optimization promotion.** See [the receipt](performance-evidence/2026-11-11-browser-profile.md).

This document describes `examples/browser_perf.rs` and
`scripts/profile-browser.mjs`. It does not change the WebAssembly ABI, the
browser bridge (`js/gl.js`), the release profile, or any root build/CI file.

## Fixed measurement workload

`examples/browser_perf.rs` is a small fixture, not a game. Every frame it
performs, in this exact order:

1. **One dynamic draw-bound buffer upload.** `buffer_update` rewrites a
   `Dynamic` vertex buffer with 4 vertices (16 bytes each, 64 bytes total).
   Vertex position is a pure function of an internal `frame_index` counter,
   never wall-clock time, so a given frame index renders the same pixels on
   every run.
2. **An upload stress run.** A second `Dynamic` buffer is allocated once at
   1024 bytes (64 vertices). Every frame, 3 separate `buffer_update` calls
   reuse that same allocation with 4, 16, and 32 vertices (64, 256 and 512
   bytes). Each size stays at or under the buffer's allocated size, matching
   `buffer_update`'s documented and enforced contract (see below). No new
   buffer is ever created for these updates.
3. **Alternating textures.** Two 4x4 RGBA8 static textures are created once.
   `Bindings.images[0]` swaps between them every frame (even/odd on
   `frame_index`), exercising a texture bind/draw without a new upload.
4. **One draw call** of a textured quad, then `commit_frame()`.

### `buffer_update` semantics this fixture relies on

Read from `src/graphics.rs` and the GL backend (`src/graphics/gl.rs`):

* `buffer_update(buffer, data)` requires `data` to be `BufferSource::slice`.
  `BufferSource::empty` is rejected (`panic!("buffer_update expects
  BufferSource::slice")`).
* The GL backend asserts `data.size <= buffer.size`: an update **must not**
  exceed the buffer's original allocated byte count. The fixture's stress
  sub-uploads (64/256/512 bytes) all stay under the allocated 1024 bytes.
* For an index buffer, the element size of the update must equal the
  buffer's original index type; this fixture never updates its (immutable)
  index buffer, so that path is untested here.
* The GL backend implementation calls `glBufferData` (a full store
  replacement), not `glBufferSubData`, for every `buffer_update`, regardless
  of the requested size. That is why the harness counts WebGL
  `bufferData`/`bufferSubData` calls together as "buffer upload calls".

## Harness: `scripts/profile-browser.mjs`

Run with:

```sh
PATH="$HOME/.cargo/bin:$PATH" \
  cargo build --release --target wasm32-unknown-unknown --example browser_perf
RUSTFLAGS="-C opt-level=z" CARGO_TARGET_DIR=target/profiling-experiment \
  cargo build --release --target wasm32-unknown-unknown --example browser_perf
node scripts/profile-browser.mjs
```

The script:

* Serves `js/gl.js` (unmodified) and both WASM builds from an in-process
  `node:http` server. It does not reuse or modify `tests/browser/serve.mjs`.
* Needs a Playwright install. It never installs one. It first looks for
  `node_modules/playwright` next to this repository, then for a sibling
  worktree's `node_modules/playwright` (a "parent absolute node_modules"),
  and finally honors `MINIQUAD_PLAYWRIGHT_ENTRY` as an explicit override.
* Launches headless Chromium with software rendering
  (`--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`), a
  fixed 640x400 viewport and `deviceScaleFactor: 1` for every run.
* Runs `MINIQUAD_PROFILE_PAIRS` paired baseline/candidate runs (default 5),
  alternating which variant goes first in each pair.
* Instruments **JavaScript wrappers around real `WebGLRenderingContext` /
  `WebGL2RenderingContext` methods** (`bufferData`, `bufferSubData`,
  `texImage2D`, `texSubImage2D`, `bindTexture`, the `draw*` family including
  the ANGLE instanced-array extension) to count calls and bytes. It does
  not read or mutate WASM memory or Rust state to produce these counts.
* Wraps `wasm_exports.frame` to time JS-to-WASM CPU duration per frame; this
  is CPU submission time, not GPU completion time. GPU timing is never
  reported as zero; it is not collected by this harness at all.
* Uses one Chrome DevTools Protocol `Profiler` session per run
  (`Profiler.start`/`Profiler.stop`) to retain the top sampled call-tree
  nodes by hit count, independent of the WebGL wrappers.
* Freezes deterministically: after a fixed frame count (120), the wrapped
  `requestAnimationFrame` stops scheduling further redraws, so the canvas
  content stops changing. The harness then reads back the exact RGBA pixels
  with `gl.readPixels` and compares baseline vs. candidate byte-for-byte
  (`pixelParity`, `maxChannelDiff`, `mismatchedPixelRatio`) instead of
  decoding a screenshot image.
* Measures `wasm_memory.buffer.byteLength` for WASM memory bytes.
  `performance.memory.usedJSHeapSize` is reported for JS heap only when the
  engine exposes it; the harness never fabricates a JS heap number, and
  records a `jsHeapReason` when it is unavailable.
* Computes raw/gzip(9)/Brotli(11) bytes and a SHA-256 for both WASM
  artifacts with Node's `zlib` and `crypto`, matching the method used by
  `scripts/compare-rust-wasm-opts.mjs`.
* Writes one raw JSON receipt per invocation to
  `MINIQUAD_PROFILE_OUT_DIR` (default `test-results/`, already excluded from
  the committed tree) and prints a summary to stdout. Raw receipts are not
  committed; see the linked evidence document for a concise, source-linked
  summary and its SHA-256.

### Pair comparison and the INCONCLUSIVE rule

For each timing metric, the harness computes the candidate-minus-baseline
delta per pair, then the median delta and the spread (max minus min) across
all pairs. If the spread is at least as large as the absolute median delta,
the result is reported as `INCONCLUSIVE`: measurement noise is as large as,
or larger than, the observed difference, so no speedup or regression is
claimed. `tests/profile-browser.test.mjs` covers this rule directly, along
with percentile/aggregation and invalid/missing-sample handling, without
needing a browser.

## Known limits

* **Allocation profiling is not available** in this harness. CDP's
  `HeapProfiler` sampling was not wired up for this change; this is recorded
  as `allocationProfiling: {available: false}` in every receipt, not claimed
  as done. #14 asks for allocation/topology comparisons that remain
  outstanding.
* Measurements come from one shared, non-dedicated development host running
  headless Chromium with software rendering (SwiftShader/ANGLE), not a
  reference device or a dedicated CI runner. Background load on a shared
  host can widen or shift timing samples; no real-time guarantee is made.
* GPU completion time is not collected; "JS-to-WASM frame CPU duration" is
  submission-side CPU time only.
* This harness does not run Firefox or WebKit, and does not run on mobile
  or native targets.
