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
* Runs `runAllocationProfile` once per invocation against a third,
  isolated WASM build (see "Allocation profiling" below) and
  `runBindCacheCounterfactual` once against the same build, adding
  `allocationProfile` and `bindCacheCounterfactual` to the JSON receipt.

### Pair comparison and the INCONCLUSIVE rule

For each timing metric, the harness computes the candidate-minus-baseline
delta per pair, then the median delta and the spread (max minus min) across
all pairs. If the spread is at least as large as the absolute median delta,
the result is reported as `INCONCLUSIVE`: measurement noise is as large as,
or larger than, the observed difference, so no speedup or regression is
claimed. `tests/profile-browser.test.mjs` covers this rule directly, along
with percentile/aggregation and invalid/missing-sample handling, without
needing a browser.

## Allocation profiling

Real Rust allocation counters and real CDP `HeapProfiler` sampling, added
for #14's remaining allocation/topology gap. Two independent, benchmark-only
counting-allocator implementations exist; neither is ever the default
allocator for a production or default build:

* `experiments/allocation-profile/` is a standalone, non-workspace-member
  Cargo crate (`CountingAllocator`, wrapping `std::alloc::System`) with its
  own unit tests, runnable without a browser:

  ```sh
  PATH="$HOME/.cargo/bin:$PATH" \
    cargo test --manifest-path experiments/allocation-profile/Cargo.toml -- --test-threads=1
  ```

  `--test-threads=1` is required: the tests share one process-wide
  `#[global_allocator]`, so parallel test threads would pollute each
  other's counters.

* `examples/browser_perf.rs` has a `#[cfg(miniquad_alloc_profile)]`-gated
  `alloc_profile` module. It `include!`s the exact same
  `experiments/allocation-profile/src/core.rs` tokens as the standalone
  crate above, so the two call sites share one counting-allocator
  implementation instead of two independently maintained copies; `include!`
  splices source tokens at compile time, so this adds no Cargo dependency
  and needs no root `Cargo.toml` edit in either direction. It is compiled
  in only with an ad hoc rustc `--cfg` (not a Cargo feature, for the same
  reason):

  ```sh
  PATH="$HOME/.cargo/bin:$PATH" \
    RUSTFLAGS="--cfg miniquad_alloc_profile" cargo build --release \
    --target wasm32-unknown-unknown --example browser_perf \
    --target-dir target/alloc-profile-experiment
  ```

  With no such `--cfg`, this module is absent and the binary is
  byte-for-byte unaffected by its presence in the source file: a default
  `cargo build --release --target wasm32-unknown-unknown --example
  browser_perf` exposes zero `alloc_profile_*` WASM exports.

  At the end of `Stage::new()`, the module runs an internal self-test
  (churn-vs-reuse: identical functional output, differing allocation
  counts; a no-op control is exactly zero) and snapshots alloc/realloc/
  dealloc call counts and live/peak bytes as the "init" baseline. It then
  exports 13 `#[no_mangle]` functions (10 current/init counter getters, the
  self-test result, an availability flag, and the bind-mode setter used by
  the `#691` counterfactual below), reachable from JS as
  `wasm_exports.alloc_profile_*` with no change needed to `js/gl.js` (it
  already exposes the full `instance.exports` object).

  `scripts/profile-browser.mjs`'s `runAllocationProfile` loads this build,
  enables CDP `HeapProfiler` sampling (16 KiB interval), reads the init and
  post-freeze-frame counter snapshots, and computes their component-wise
  delta (`allocationPhaseDelta`) — **a total over the counted frames, never
  presented as a rate**. It also returns the top sampled heap-allocation
  call sites by self size from the real CDP sampling profile
  (`topHeapSamplingNodes`).

## Upstream `#682`/`#691` investigation

Both are read from `not-fl3/miniquad` via `gh pr view --repo not-fl3/miniquad`,
not this fork's issue tracker, because they describe upstream PRs, not
local issues:

* **`#682`** ("gl: give a buffer a new store each time it's updated"):
  upstream state `OPEN` (not merged there). This fork already uses
  `glBufferData` (not `glBufferSubData`) in `buffer_update`
  (`src/graphics/gl.rs`), matching `#682`'s intent, via commit `a15aa10`
  ("[Integration / DRAFT] OpenGL correctness and buffer updates from
  upstream #691, #682 (#2)"), which predates this change's baseline. No
  source change was needed; this fixture's existing size-varied
  `buffer_update` calls (a 64-byte full rewrite plus three differently
  sized sub-uploads per frame) already exercise that call path and were
  already measured (equal baseline/candidate byte counts) in
  `docs/performance-evidence/2026-11-11-browser-profile.md`.
* **`#691`** ("graphics/gl: forget deleted textures in the binding cache"):
  upstream state `OPEN` (not merged there). This fork already has
  `GlCache::forget_texture` (`src/graphics/gl/cache.rs`), matching `#691`,
  via the same `a15aa10` commit. `GlCache::bind_texture` also already dedups:
  it skips the underlying `glBindTexture` call when the requested slot
  already holds that exact `(target, texture)` pair.

  `scripts/profile-browser.mjs`'s `runBindCacheCounterfactual` is a labeled,
  non-production counterfactual for the dedup behavior. It is a *within-pass*
  (not cross-frame) counterfactual, because this fixture calls
  `ctx.commit_frame()` once per frame, which resets `GlCache`'s texture-slot
  cache to 0 (`commit_frame` → `cache.clear_texture_bindings()`,
  `src/graphics/gl.rs`), so a cross-frame "does frame N+1 dedup against
  frame N's final bind" test can never exercise `bind_texture`'s dedup path:
  every frame always starts from an empty cache. Instead,
  `examples/browser_perf.rs`'s `apply_alloc_profile_bindings` (reachable
  only under `--cfg miniquad_alloc_profile`) issues 4 `apply_bindings` calls
  within one *uncommitted* pass, before the single final `draw`, using a
  harness-controlled sequence (`alloc_profile_set_bind_mode`): mode 0
  ("repeat") binds `texture_a` four times in a row (A,A,A,A); mode 1
  ("alternate") binds A,B,B,A. Both sequences end on `texture_a`, so the
  frame's rendered pixel output is identical between modes regardless of
  whether dedup happens — a fair counterfactual on real `glBindTexture`
  call *counts*, not a pixel-content change. The harness loads the
  alloc-profile WASM build twice (fresh browser and page each time, one per
  mode) and compares real WebGL `bindTexture` call counts between the two
  modes over 120 frames.

  The mode is applied race-free, before the first real animation frame, by
  overriding `window.requestAnimationFrame` via `page.addInitScript` and
  calling `wasm_exports.alloc_profile_set_bind_mode` on that override's
  first-ever invocation (which `js/gl.js`'s load sequence guarantees runs
  after `wasm_exports` is assigned and strictly before any real frame
  callback). An earlier version of this harness passed `freezeFrame` and
  the bind mode as two separate positional arguments to
  `page.addInitScript(fn, arg1, arg2)`; Playwright's `addInitScript` API
  accepts only one `arg` value per call and silently drops further
  arguments, so the bind mode was never actually being applied and both
  modes measured identically (244/120 frames each) — a real harness bug,
  not an upstream or `GlCache` defect. This was found and fixed in this
  change by passing a single destructured options object instead; see
  `pageInstrumentation`'s doc comment in `scripts/profile-browser.mjs`.

  **Measured result** (after the fix, representative run; raw JSON
  preserved outside the git worktree per this change's provenance
  requirements): `repeat` mode produced 244 real `bindTextureCalls` over
  120 frames (≈2.03/frame); `alternate` mode produced 484
  (≈4.03/frame) — both `pixelParity.mismatchedPixelRatio === 0`
  (identical final rendered pixels, as expected). This matches the
  source-level prediction: `repeat`'s 3 consecutive same-texture binds
  within the pass should dedup to 1 real bind (plus 1 real unbind-to-0 at
  the next `commit_frame`, giving ≈2/frame), while `alternate`'s single
  repeated middle pair (B,B) should dedup once out of 3 real binds (plus
  the same unbind-to-0, giving ≈4/frame). This is reported as a genuine,
  real, measured result **confirming** `GlCache::bind_texture`'s dedup is
  reached and functions correctly within an uncommitted pass; it does not
  and cannot demonstrate cross-frame dedup, because `commit_frame` always
  clears the cache between frames (see above) — that is a property of this
  fixture's per-frame structure, not of `GlCache` itself.

  A second, one-shot counterfactual (`alloc_profile_request_delete_
  recreate`) exercises `GlCache::forget_texture` directly: it binds
  `texture_a`, deletes it, creates a new texture with identical pixel
  content, and rebinds. In a representative run this applied at frame 1
  with `bindTextureCallsAfterRequest: 241` (at least the 2 real binds the
  probe itself always performs). A real bind being recorded here is
  consistent with `forget_texture` correctly invalidating the cache slot on
  delete, but browser/driver GLuint name reuse after `glDeleteTextures` is
  not forced or guaranteed by this harness, so this does not by itself
  prove the specific numeric-name-reuse collision scenario `forget_texture`
  exists to guard against — only that the delete/recreate/rebind path
  itself runs and keeps rendering correctly.

## Pixel-readback correctness fixes (this change)

A later review of the harness found that `scripts/profile-browser.mjs`'s
pixel-reading code could report false pixel parity. These defects were
fixed in this change, each with a focused regression test
(`tests/profile-browser.test.mjs`) that fails against the old code:

1. **Silent catch-and-zero reads.** All three `gl.readPixels` call sites
   (`runOnce`, `runSequenceMode`, `runDeleteRecreateProbe`) wrapped the
   call in `try { gl.readPixels(...) } catch { /* left empty */ }` around a
   pre-zeroed buffer. A thrown `readPixels` call (including one caused by a
   lost WebGL context) was silently swallowed, and the untouched all-zero
   buffer was returned and compared as if it were a real frame — two runs
   that both actually failed to read anything could report
   `pixelParity.mismatchedPixelRatio === 0` and look identical. This is
   fixed by a single shared, strict reader
   (`window.__readFramebufferPixelsStrict`, injected by
   `pageInstrumentation`) that rethrows on a thrown `readPixels`, throws on
   a lost context, throws on a non-`NO_ERROR` `gl.getError()` after the
   call, and throws on a fully constant/blank readback (safe for this
   fixture specifically, because `examples/browser_perf.rs`'s `texture_a`/
   `texture_b` are genuinely non-uniform 4x4 checkerboard textures rendered
   over a clear color in every build variant). It also reads the canvas's
   actual `width`/`height` rather than the hardcoded `VIEWPORT` constant
   (which remains correctly used only for `browser.newContext`'s window
   size), so a resize or DPI difference can never silently truncate or
   corrupt the comparison.
2. **Discarded delete/recreate pixels.** `runDeleteRecreateProbe` read
   pixels internally but discarded them, so the delete/recreate/rebind
   path never had a pixel-parity result despite this document's prior
   text implying one. It now returns its captured pixels, and
   `runBindCacheCounterfactual` computes `deleteRecreateProbe.
   pixelParityVsRepeat` against the same-image `repeat`-mode reference run
   (same `freezeFrame`, same default bind mode, both ending on a
   byte-identical `texture_a`): `mismatchedPixelRatio === 0` there means
   the delete/recreate/rebind sequence rendered the same final image as a
   run that never deleted anything — the meaningful parity claim this
   probe can actually support (see the code comment there for what it
   still cannot prove about GL numeric-name reuse).
3. **Silently-marked bind mode.** The `requestAnimationFrame` override's
   bind-mode guard previously set `bindModeConfiguredAtFrame` unconditionally,
   even when `initialBindMode` was a number but
   `wasm_exports.alloc_profile_set_bind_mode` was missing or not callable —
   a run that actually measured the Rust-side default mode could look like
   a successfully configured counterfactual. It now throws (and sets
   `window.__perf.fatalError`) instead, before marking the mode configured.
4. **Blank-readback timing defect (found while fixing the above).** After
   fixing (1)-(3) and re-running the real harness, reads genuinely came
   back all-zero (`gl.getError() === 0`, no error, no lost context) — the
   new strict reader correctly caught a real defect the old silent-catch
   code had been masking all along. Root cause: `js/gl.js`'s
   `canvas.getContext("webgl"/"webgl2")` calls use the default
   `preserveDrawingBuffer: false`, and its `animation()` render loop calls
   `wasm_exports.frame()` then `window.requestAnimationFrame(animation)`
   again *synchronously, in the same task*, before the browser yields to
   its compositor. Reading pixels later, via a separate, asynchronous
   `page.evaluate` round-trip (every prior call site, including the
   just-fixed strict reader when called that way), is not guaranteed to
   still see that frame's content once the browser has composited and is
   free to invalidate the un-preserved drawing buffer. The fix captures
   `window.__readFramebufferPixelsStrict()`'s result *synchronously*,
   inside `pageInstrumentation`'s own `requestAnimationFrame` override, at
   the exact point it detects the freeze condition (the last point
   reachable from the same synchronous call as the just-completed draw),
   storing the result on `window.__perf.frozenFramePixels`/
   `frozenFrameSize`; every Node-side call site now just reads that
   already-captured data. Setting `preserveDrawingBuffer: true` in
   `js/gl.js` would be a simpler, more conventional fix, but `js/gl.js` is
   root runtime/bridge code outside this change's owned scope
   (`examples/browser_perf.rs`, `scripts/profile-browser.mjs`,
   `tests/profile-browser.test.mjs`, `experiments/allocation-profile/**`,
   and this document), so it was not modified.

   This also means **any pixel-parity evidence from runs before this fix
   may have been comparing blank buffers**, not real rendered frames,
   regardless of what was claimed. The `repeat`-mode bind-count numbers in
   the previous section do not depend on pixel reads and remain valid;
   only pixel-parity claims are affected. The harness was re-run after
   this fix (3 alternating pairs; see
   `performance-evidence/2026-11-11-allocation-profile.md`) and real,
   non-blank pixels were captured and compared in every case (the strict
   reader's blank-frame check did not throw on any of them).

## Known limits

* Measurements come from one shared, non-dedicated development host running
  headless Chromium with software rendering (SwiftShader/ANGLE), not a
  reference device or a dedicated CI runner. Background load on a shared
  host can widen or shift timing samples; no real-time guarantee is made.
* GPU completion time is not collected; "JS-to-WASM frame CPU duration" is
  submission-side CPU time only.
* This harness does not run Firefox or WebKit, and does not run on mobile
  or native targets.
* The counting allocators assume single-threaded execution (an atomic
  counter per call is correct under concurrent calls, but "peak bytes" as a
  simple monotonic watermark is only meaningful for one logical phase at a
  time; see `reset_peak()` in `experiments/allocation-profile/src/lib.rs`).
  This fixture and this harness are both single-threaded, so this does not
  affect the reported numbers, but it would need revisiting before reuse in
  a multi-threaded example.
* The `#691` within-pass bind-cache counterfactual confirms `GlCache::
  bind_texture`'s dedup is reached and works within a single uncommitted
  pass (see above), but cannot and does not demonstrate cross-frame dedup,
  because this fixture's `commit_frame` call clears the texture-slot cache
  every frame. A cross-frame dedup counterfactual would need a different
  fixture structure (for example, one that never calls `commit_frame`
  between repeated binds of the same texture), which is out of this
  change's scope.
* The delete/recreate/rebind probe for `GlCache::forget_texture` observes
  that the delete → create → rebind path runs and renders correctly, but
  does not force or verify GL/browser-driver numeric-name reuse after
  `glDeleteTextures`, so it cannot by itself prove the specific name-reuse
  collision scenario `forget_texture` exists to guard against.
* The freeze-time synchronous pixel-capture fix (see "Pixel-readback
  correctness fixes" above) is based on the observed call order in
  `js/gl.js`'s current `animation()`/`requestAnimationFrame` sequencing,
  not on a browser or WebGL spec guarantee about exactly when a
  non-preserved drawing buffer becomes invalid. It is verified empirically
  (the real harness captured non-blank, checkerboard-consistent pixels in
  every run after this fix, where it previously failed reliably), not
  proven from first principles; a future browser/engine change to that
  timing could reintroduce the blank-read failure, which the strict
  reader's blank-frame check would still catch loudly rather than silently
  reporting false parity.
