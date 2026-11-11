# Real allocation profiling and upstream buffer/texture-cache review — 2026-11-11

Use section 9 for the final measured revision and corrected results.
Earlier sections retain superseded measurements and rejected claims.
Public command excerpts use `$PLAYWRIGHT_ENTRY` in place of a local absolute
path. Set this variable to your installed Playwright entry point.

**Evidence status:** Measured native and browser-profiled allocation
receipt for the exact source revision below, plus a source-citation review
of upstream not-fl3/miniquad `#682`/`#691`. **Not** release qualification,
not a promoted optimization, and not a cross-engine or reference-device
measurement. Closes the allocation-profiling and upstream buffer/
texture-cache gap left open by
[2026-11-11-browser-profile.md](2026-11-11-browser-profile.md) toward
[#14](https://github.com/Tigon32/miniquad/issues/14), which **remains
open** for its other unchecked items (see that receipt's "Remaining work").

**Revision note:** an earlier receipt for this same gap (commit
`73decfaa660e86696ffb5f5972b0f46698a351b0`) was rejected before this
revision for six material defects: a duplicated (not shared) allocator
implementation; an inaccurate claim that CDP heap sampling could attribute
Rust/WASM allocations; a single-window "no leak" claim built on clamped,
unvalidated counter deltas; a mischaracterization of upstream `#691` as a
cross-frame dedup fix and an unresolved within-pass counterfactual bug that
made both its modes measure identically; missing bounded
waits/cleanup; and unverified source/artifact provenance. This document
supersedes that receipt's conclusions with corrected code and real,
re-measured numbers; see each section below for what changed and why.

- Source revision measured: baseline `f837a98d415262320a8c66ef9f8024d8f2faeab1`
  (worktree `feat/allocation-proof`); this document is committed on top of
  it as a separate commit — see the exact revision in this worktree's
  `git log` at handoff time, not restated here to avoid staleness if
  amended (which this change does not do).
- New/changed files measured, with independently-reproduced SHA-256 (via
  `shasum -a 256`, matching the harness's own `sourceProvenance()` output):
  - `examples/browser_perf.rs`:
    `26089b534c33cf89c4b619c28af7effe6300e89a846459c876de4080720ce785`
  - `experiments/allocation-profile/src/core.rs`:
    `39ada104ccdddc2127c30099f3bc82c15801fc7fd3b8a6b7bb54e9c579bc7f47`
  - `experiments/allocation-profile/src/lib.rs`:
    `1c9e6e1714184b4eade0c2f533752496172678dbe0461599fc75a8f7bcea21ca`
  - `scripts/profile-browser.mjs`:
    `546e0ec0926cb8b69dd261cc9de21259e836d4d6550c7929ad7a053fe5d27173`
  - `tests/profile-browser.test.mjs`:
    `e108b87e61a8e99f7c530a40bda6742f67d4cecbb619a0d9950df23443cfadcb`
  - `docs/browser-profiling.md`:
    `4a6afcae3e183d105570bda28c4897674890dcfb68a57f3fbc8ae4672978491e`
  - Built artifact, alloc-profile WASM
    (`target/alloc-profile-experiment/wasm32-unknown-unknown/release/examples/browser_perf.wasm`,
    rebuilt fresh from the above sources immediately before measurement):
    `72ae8db300f076add0c577485154be0f82cba8d33433169db7a84133cfd0d906`
- Toolchain: `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0`, Node
  `v26.10.0`, Playwright `1.56.1` (resolved from a sibling worktree's
  `node_modules`, not installed by this change). Host OS: macOS, Darwin
  arm64 (`sysctl -n hw.ncpu` = 12).
- **Host note:** one shared, non-dedicated development machine, not an
  isolated benchmark rig or CI runner. No timing claim in this document
  depends on this host's absolute CPU speed; every number below is a real
  **count**, not a duration, except where explicitly marked otherwise.
- Raw JSON receipt (the full `allocationProfile` and
  `bindCacheCounterfactual` sections this document summarizes, from the
  same representative run as the numbers below): retained as a session
  artifact at
  `files/performance-evidence/2026-11-11-full-harness-output-postfix.json`
  in this session's working storage (not committed to the repository). A
  separate raw receipt describing the `addInitScript` argument-arity bug
  found and fixed in this revision (see §3) is retained alongside it at
  `files/performance-evidence/bind-mode-raf-arg-bug-raw-receipt.md`.

## 1. Native Rust allocation counters (no browser)

`experiments/allocation-profile/` is a standalone, non-workspace-member
Cargo crate. Its allocator (`CountingAllocator`, `#[global_allocator]`
wrapping `std::alloc::System`; atomics for alloc/realloc/dealloc call
counts and live/peak bytes) now lives in a single shared source file,
`experiments/allocation-profile/src/core.rs`, `include!`-d by both
`experiments/allocation-profile/src/lib.rs` (this native crate) and
`examples/browser_perf.rs`'s `#[cfg(miniquad_alloc_profile)]`-gated module
(§2) — **not** two independent implementations, correcting the prior
receipt's duplicated-allocator defect. It is never linked into the
`miniquad` library or any example by default; it exists purely as an
isolated benchmark-only instrument.

```sh
PATH="$HOME/.cargo/bin:$PATH" \
  cargo test --manifest-path experiments/allocation-profile/Cargo.toml -- --test-threads=1
```

Result: **5 passed; 0 failed.**

| Test | Proves |
| --- | --- |
| `noop_control_is_exactly_zero` | A measurement window with no real allocator call reports exactly 0 for every counter — the counting mechanism does not fabricate a nonzero baseline. |
| `known_allocation_and_deallocation_are_detected` | One known `Vec` allocation and its drop produce exactly 1 alloc call, 1 dealloc call, and the exact requested byte count in live/peak bytes — real requested bytes, not a WASM-page surrogate. |
| `churn_and_reuse_produce_identical_output_with_different_allocation_counts` | A "churn" loop (new `Vec` per frame) and a "reuse" loop (one `Vec`, cleared and refilled) produce bit-identical functional output (fixed-size `[f32; FRAMES]` checksum arrays, chosen specifically so the comparison itself never allocates) while the churn loop reports exactly `FRAMES` alloc calls and the reuse loop reports at most 1 — the real, controlled counterfactual the task asked for. |
| `delta_rejects_a_call_count_that_moved_backwards` | `delta()` returns `Err` (never clamps to 0 or silently drops the sample) when a call count appears to move backwards between two snapshots — correcting the prior receipt's unvalidated-delta defect. |
| `delta_reports_negative_live_and_peak_bytes_as_valid_after_a_reset` | A legitimately negative `liveBytesDelta`/`peakBytesDelta` (for example, after `reset_peak()` rebases the watermark) is reported honestly as a signed value, not clamped to 0 or treated as an error — only call-count regressions are rejected, not all negative deltas. |

`--test-threads=1` is required and documented in the crate (and in
`docs/browser-profiling.md`): Rust's test harness runs tests on separate
OS threads concurrently within one process by default, and a custom
`#[global_allocator]` is process-wide shared state, so concurrent test
threads race on the same counters. A `Mutex`-guarded critical section was
added around each allocation-sensitive test body as defense in depth, but
empirically does **not** fully eliminate the race by itself (confirmed:
still fails intermittently at `--test-threads=2` even with the mutex
present, because the test harness's own per-thread setup/teardown touches
the allocator outside any lock a test body can acquire).
`--test-threads=1` was verified reliable across 8 repeated runs (5/5 tests
passing each time).

## 2. Real WASM allocation counters from a live browser run

`examples/browser_perf.rs` has a `#[cfg(miniquad_alloc_profile)]`-gated
`alloc_profile` module that `include!`s the same shared `core.rs` as §1
(not a duplicate implementation — see above). It compiles in only with an
ad hoc rustc `--cfg` (not a Cargo `[features]` entry, since that would
require editing the root `Cargo.toml`, out of this change's scope):

```sh
PATH="$HOME/.cargo/bin:$PATH" \
  RUSTFLAGS="--cfg miniquad_alloc_profile" cargo build --release \
  --target wasm32-unknown-unknown --example browser_perf \
  --target-dir target/alloc-profile-experiment
```

**Verified isolation, both directions:**
- Default build (`cargo build --release --target wasm32-unknown-unknown
  --example browser_perf`, no `--cfg`): 0 `alloc_profile_*` WASM exports.
  This module cannot affect a default/consumer build's exports. This
  change does **not** claim the resulting default-build *binary* is
  byte-identical to one built without this change under equal flags (that
  was not re-verified this round); the claim made and verified is narrower
  and specific: the `cfg`-gated module adds no exports and is not reachable
  without the `--cfg` flag.
- `--cfg`-enabled build: real `alloc_profile_*` exports present (current/
  init counter getters, the self-test result, an availability flag, the
  bind-mode setter and delete/recreate request used in §3).

`scripts/profile-browser.mjs`'s `runAllocationProfile` loads this build in
headless Chromium, reads the init-phase snapshot, then reads **two
equal-length (30-frame) steady-phase windows after a 60-frame warmup**
(`reset_peak()` called at the start of each window so its
`peakBytesInWindow` is an absolute "peak reached strictly within this
window" figure, not a difference between unrelated global watermarks) —
correcting the prior receipt's single-window "net +72 bytes, no leak"
claim, which could not by itself distinguish a bounded steady state from
an early window that merely hadn't yet started leaking.

One representative live run (120 freeze-gated frames, `reset_peak()`
before each window):

| Phase | Alloc calls (delta) | Dealloc calls (delta) | Live bytes delta | Peak bytes in window |
| --- | ---: | ---: | ---: | ---: |
| Init (`Stage::new`, absolute) | 35 | 22 | — (live 2,381) | 2,893 |
| Window A (frames 61–90) | 93 | 93 | **0** | 2,965 |
| Window B (frames 91–120) | 87 | 87 | **0** | 2,965 |

Self-test result read from the real WASM export: `{ran: true, pass: true}`
— the churn-vs-reuse/no-op counterfactual from §1 also passed inside the
real browser-targeted build, not just the native experiment crate.

**Reading this honestly:** both post-warmup windows show alloc calls
exactly equal to dealloc calls and a `liveBytesDelta` of exactly 0 — a
real, repeatable, after-startup-window observation consistent with a
bounded steady state for this fixture's two 30-frame windows, not a
universal "no leak, ever" guarantee (a longer run or a different workload
could still show growth; this document reports only what these two windows
showed, with their boundaries stated). Had either delta shown a nonzero
`liveBytesDelta`, that would have been reported as an unresolved,
unexplained growth, not glossed over or re-labeled; `delta()`'s contract
(§1) guarantees a backwards call count throws rather than silently
clamping, so these zero deltas are not an artifact of error-hiding.

**Real CDP `HeapProfiler` sampling** (16 KiB interval, same live run): top
sampled call sites by self size were exclusively JS/V8-side (`(V8 API)`,
`(BYTECODE_COMPILER)`, `pageInstrumentation`, `js/gl.js` call sites). This
is expected and **not a sampling-interval limitation**: CDP's
`HeapProfiler` instruments the JS/V8-managed heap only and has no
visibility into WASM linear memory at any interval, so it can never
attribute a Rust `alloc`/`dealloc` call here regardless of granularity.
The 361-ish real Rust allocations/deallocations measured above are a
wholly separate, independently-counted figure (§1/§2's own atomics), not
something CDP's sampler could corroborate or contradict. JS heap size, WASM
linear-memory capacity (via `WebAssembly.Memory.buffer.byteLength`, if
read), and Rust live/peak bytes are three different, non-interchangeable
quantities; this document reports only the latter two, with the former
explicitly noted as JS-heap-only and not Rust-attributing. Full top-10
list is in the raw JSON receipt.

## 3. Upstream not-fl3/miniquad `#682` / `#691`

Read from the upstream repository directly
(`gh pr view --repo not-fl3/miniquad 682` /
`gh pr view --repo not-fl3/miniquad 691`), not this fork's issue tracker:

| PR | Upstream state | Intent | This fork's status |
| --- | --- | --- | --- |
| [`#682`](https://github.com/not-fl3/miniquad/pull/682) | `OPEN` (not merged upstream) | "gl: give a buffer a new store each time it's updated" — use `glBufferData` instead of `glBufferSubData` in `buffer_update`, to avoid driver copy-on-write stalls. | **Already integrated.** `buffer_update` in `src/graphics/gl.rs` already calls `glBufferData`, matching intent, via this fork's commit `a15aa10` ("[Integration / DRAFT] OpenGL correctness and buffer updates from upstream #691, #682 (#2)"), predating this change's baseline. |
| [`#691`](https://github.com/not-fl3/miniquad/pull/691) | `OPEN` (not merged upstream) | "graphics/gl: forget deleted textures in the binding cache" — add `GlCache::forget_texture` so a texture name reused after deletion is not mistaken for already-bound. This is a **deletion-cache-invalidation** fix, not a cross-frame bind-dedup mechanism; `GlCache::bind_texture`'s existing same-slot dedup is a separate, pre-existing property this round measures as a counterfactual. | **Already integrated.** `GlCache::forget_texture` exists in `src/graphics/gl/cache.rs`, matching intent, via the same `a15aa10` commit. `GlCache::bind_texture` also already dedups: it skips the real `glBindTexture` call when the slot already holds the requested `(target, texture)` pair. |

No source change was needed for either item; this round's contribution is
confirming and measuring already-integrated behavior, with a real
workload:

- **`#682` (buffer uploads):** this fixture's existing per-frame workload
  (a 64-byte full vertex-buffer rewrite plus three size-varied sub-uploads,
  all `<= 1024`-byte `STRESS_CAPACITY_BYTES`) already exercises
  `buffer_update`'s `glBufferData` call path every frame, and was already
  measured with equal baseline/candidate byte counts in
  [2026-11-11-browser-profile.md](2026-11-11-browser-profile.md). No
  further buffer-upload evidence was collected in this round beyond
  confirming the source match above.

- **`#691` (texture-cache dedup), within-pass counterfactual:**
  `examples/browser_perf.rs`'s `apply_alloc_profile_bindings`
  (`#[cfg(miniquad_alloc_profile)]`-only) issues 4 `apply_bindings` calls
  within one *uncommitted* pass before the single final `draw`, using a
  harness-controlled sequence (`alloc_profile_set_bind_mode`): mode 0
  ("repeat") binds `texture_a` four times in a row (A,A,A,A); mode 1
  ("alternate") binds A,B,B,A. Both sequences end on `texture_a`, so the
  frame's rendered pixel output is identical between modes regardless of
  dedup — a fair counterfactual on real `glBindTexture` call *counts*, not
  a pixel-content change. This is a **within-pass**, not cross-frame,
  counterfactual: this fixture calls `ctx.commit_frame()` once per frame,
  which resets `GlCache`'s texture-slot cache to 0
  (`commit_frame` → `cache.clear_texture_bindings()`,
  `src/graphics/gl.rs`), so a cross-frame dedup test can never be exercised
  by this (or any) per-frame-committed fixture — that is a structural
  property of `commit_frame`, not a limitation of the dedup mechanism
  itself.

  **A real harness bug was found and fixed in this revision before these
  numbers could be trusted:** the prior receipt's within-pass
  implementation measured identical `bindTextureCalls` for both modes
  (244/120 frames each) because `runSequenceMode(mode)` called
  `page.addInitScript(pageInstrumentation, freezeFrame, mode)` —
  Playwright's `Page.addInitScript(script, arg)` accepts exactly **one**
  `arg` value and silently drops a third positional argument, so the bind
  mode was never actually applied; `BIND_MODE` stayed at its default
  (repeat) for both requested modes. This was root-caused by (1)
  reproducing the identical-count symptom at multiple frame counts, (2)
  confirming via a direct post-load `page.evaluate` call that setting the
  mode *does* change real bind counts (proving the underlying `GlCache`
  dedup and the `alloc_profile_set_bind_mode` export both work correctly),
  and (3) re-reading `page.addInitScript`'s type signature and finding the
  extra-argument mismatch. Fixed by passing a single destructured options
  object (`{ freezeFrame, initialBindMode }`) instead of positional
  arguments; see `pageInstrumentation`'s doc comment in
  `scripts/profile-browser.mjs` and the raw root-cause receipt in this
  session's retained artifacts (path above) for the full diagnostic trail.

  **Measured result after the fix** (one representative run, 120 frames
  each mode):

  | Mode | `bindTexture` calls | Calls/frame | Pixel parity |
  | --- | ---: | ---: | --- |
  | Repeat (A,A,A,A) | 244 | ≈2.03 | `mismatchedPixelRatio: 0` |
  | Alternate (A,B,B,A) | 484 | ≈4.03 | `mismatchedPixelRatio: 0` |

  This matches the source-level prediction: `repeat`'s 3 consecutive
  same-texture binds within the pass dedup to 1 real bind (plus 1 real
  unbind-to-0 at the next `commit_frame`, giving ≈2/frame); `alternate`'s
  single repeated middle pair (B,B) dedups once out of 3 real binds (plus
  the same unbind-to-0, giving ≈4/frame). Reported as a genuine, real,
  measured result **confirming** `GlCache::bind_texture`'s dedup is reached
  and works correctly within an uncommitted pass — correcting the prior
  receipt's inconclusive verdict, which was actually just this harness bug,
  not a real property of `GlCache` or this fixture.

  A second, one-shot counterfactual (`alloc_profile_request_delete_
  recreate`) exercises `GlCache::forget_texture` directly: bind
  `texture_a`, delete it, create a new texture with identical pixel
  content, rebind. In the same representative run this applied at frame 1
  with `bindTextureCallsAfterRequest: 241` (at least the 2 real binds the
  probe itself always performs). A real bind being recorded here is
  consistent with `forget_texture` correctly invalidating the cache slot on
  delete, but browser/driver GLuint numeric-name reuse after
  `glDeleteTextures` is not forced or verified by this harness (it is
  browser/driver-dependent), so this is reported as a render/bind-count/
  parity observation, not as deterministic proof of the specific
  name-reuse collision scenario `forget_texture` exists to guard against.

## 4. Pixel-readback correctness follow-up (this revision)

A further review found that `scripts/profile-browser.mjs`'s pixel-reading
code could report false pixel parity, independent of the issues §§1-3
corrected. Full description and fix: `docs/browser-profiling.md`'s
"Pixel-readback correctness fixes" section. Summary of what changed and
was re-measured:

- All three `gl.readPixels` call sites previously caught and silently
  discarded a thrown read into a pre-zeroed buffer, with no
  `gl.getError()`/context-loss/blank-frame check; `runDeleteRecreateProbe`
  read pixels but never exposed a parity result; the bind-mode guard
  marked itself configured even when the required WASM export was
  missing. Fixed via a shared strict reader
  (`window.__readFramebufferPixelsStrict`), a real
  `deleteRecreateProbe.pixelParityVsRepeat` result, and a guard that
  throws instead of silently proceeding.
- Fixing the above surfaced a genuine, previously-masked defect: pixel
  reads came back all-zero with no GL error because `js/gl.js`'s WebGL
  context uses the default `preserveDrawingBuffer: false` and its render
  loop re-schedules `requestAnimationFrame` synchronously before any later,
  separate `page.evaluate`-based read could run. Fixed by capturing pixels
  synchronously inside `pageInstrumentation`'s own
  `requestAnimationFrame` override at freeze time (`window.__perf.
  frozenFramePixels`/`frozenFrameSize`), never via a later out-of-band
  read. `js/gl.js` itself was not modified (outside this change's owned
  scope).
- Regression tests added to `tests/profile-browser.test.mjs` run the
  *actual* `pageInstrumentation` source (via `vm`, not a hand-copied
  duplicate) against fake failure-injecting `gl`/`canvas` stand-ins; all
  9 new tests fail against the pre-fix committed harness (confirmed by
  `git stash`-ing the harness file back to the previously-committed
  revision and re-running) and pass against the fix.
- Full suite after the fix: `node --test tests/*.test.cjs
  tests/profile-browser.test.mjs` → **95 passed, 0 failed** (was 86 before
  this revision's 9 new tests).
- Re-ran the real harness after the fix
  (`MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs`, same WASM
  artifacts as §§1-3, no Rust source changed this revision): it completed
  without the blank-frame failure that the strict reader had previously
  (correctly) surfaced. Representative result: all 3 timing-pair
  `pixelParity` entries and the `bindCacheCounterfactual.
  withinPassSequence.pixelParity`/`deleteRecreateProbe.
  pixelParityVsRepeat` entries report `equalSize: true, maxChannelDiff: 0,
  mismatchedPixelRatio: 0` — real, non-blank, byte-identical-where-expected
  pixel comparisons, not the previously-masked all-zero reads. Raw JSON
  receipt from this rerun retained as a session artifact at
  `files/performance-evidence/browser-profile-1794390491349-pixelfix-rerun.json`
  (SHA-256 `bc5e57283271fe66b88ff4ecfe1f4b599c9ebdfed2a5792a0ecbccd369e4af93`),
  not committed to the repository.
- Updated source SHA-256 (independently reproduced via `shasum -a 256`)
  for the files this revision changed:
  - `scripts/profile-browser.mjs`:
    `0010d72daf9015a7f941ad460e3b88876611c78576b42ef067a3597e36668263`
  - `tests/profile-browser.test.mjs`:
    `690a64579d9837900731ac929ed606fb473ec1264ed2a3f619cde9f8bebd678d`
  - `docs/browser-profiling.md`:
    `848c68dbc7f647820b224267b7467f6a2d0df56f137130d12f65d2dd73199a74`
- **This revision does not change, and did not need to re-verify, §§1-3's
  native allocator, WASM allocation-counter, or upstream `#682`/`#691`
  bind-cache conclusions** — those depend on real exported counters and
  call counts, not on pixel reads, and remain valid as stated above. Only
  pixel-parity claims made anywhere in this document or
  `docs/browser-profiling.md` before this revision are affected, and
  should be read as unverified until this revision (they relied on the
  same silently-swallowed/blank-read-prone code described here).

## 5. Reject opaque blank frames

Parent review reproduced one more false result at `78474f4`.
The strict reader compared adjacent bytes, not complete RGBA pixels.
It accepted uniform opaque black `[0, 0, 0, 255]` as non-uniform content.
The new test failed with `Missing expected exception` before the correction.

The reader now compares each complete pixel with the first pixel.
It rejects opaque black, the uniform clear color, and other solid RGBA colors.
The receipt also records hashes for the measurement script and browser bridge.
`node --test tests/*.test.cjs tests/profile-browser.test.mjs` passed
all 96 tests after the correction.

A three-pair local run passed all five pixel comparisons with
`equalSize: true`, `maxChannelDiff: 0`, and `mismatchedPixelRatio: 0`.
The repeat and alternate sequences measured 2.0333 and 4.0333 texture binds
per frame. This is a call-count observation, not a speed claim.
The private receipt is `browser-profile-1794391406578.json`, SHA-256
`59ff9392f2ebd3a7d26f0bc57d244d9a50c1c88e90f36b4fd8736eb363327fe3`.
This run preceded the two extra provenance hash fields.

## 6. Final run after merging master (local only, not pushed)

`master` was merged locally into this branch (commit `cf238ff`, "Qualify
drawing package consumption from a generated Git starter (#137)", the
current `origin/master` tip at merge time) to bring this branch up to
date before handoff. The merge was local only: no push, no PR, no
merge into the shared `master` branch. `git diff --stat f837a98
origin/master -- examples/browser_perf.rs experiments/allocation-profile/
scripts/profile-browser.mjs tests/profile-browser.test.mjs
docs/browser-profiling.md docs/performance-evidence/2026-11-11-allocation-profile.md
js/gl.js` reported no changes, so this merge did not touch any file this
change owns or depends on, and the already-built alloc-profile WASM
artifact remained valid (its recorded source hashes, below, are
unchanged from §5).

Verified on the merged tree (merge commit
`7ca04154d4c55bd3c6450b464f4d0a2ce6548627`):

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo test --lib
# => 10 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check --target wasm32-unknown-unknown --lib
# => Finished (no errors)

node --test tests/*.test.cjs tests/profile-browser.test.mjs
# => tests 96, pass 96, fail 0

node scripts/check-docs.mjs
# => Documentation paths, decision statuses, and skill pointers passed.
```

Final three-pair harness run, run directly (no hosted CI, no GitHub
Actions, no Docker/`act`) against this exact committed, merged revision:

```sh
PATH="$HOME/.cargo/bin:$PATH" \
GITHUB_SHA=7ca04154d4c55bd3c6450b464f4d0a2ce6548627 \
MINIQUAD_RUSTC_VERSION="rustc 1.99.0 (b940084d7 2026-09-28)" \
MINIQUAD_PLAYWRIGHT_ENTRY="$PLAYWRIGHT_ENTRY" \
MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs
```

The receipt's own `sourceRevision` and `rustcVersion` fields echoed back
exactly the `GITHUB_SHA`/`MINIQUAD_RUSTC_VERSION` values above (not a
fallback placeholder), confirming the run was actually attributed to
this exact revision and toolchain, not assumed. All 5 pixel comparisons
(3 timing-pair `pixelParity` entries, `bindCacheCounterfactual.
withinPassSequence.pixelParity`, and `deleteRecreateProbe.
pixelParityVsRepeat`) reported `equalSize: true, maxChannelDiff: 0,
mismatchedPixelRatio: 0` — real, non-blank reads under both the §4 timing
fix and the §5 opaque-frame fix. `bindTextureCallsPerFrame` remained
2.0333 (repeat) / 4.0333 (alternate), consistent with §3. No speed/timing
verdict is drawn from this run: `comparisons.*.verdict` is `INCONCLUSIVE`
or `MEASURED` call-count/CPU-duration-sample language only, on this same
shared, non-dedicated host, exactly as in every prior receipt in this
document.

- Source/artifact SHA-256 for this final run (independently reproduced
  via `shasum -a 256` on the merged tree, matching the receipt's own
  `sourceProvenance` output):
  - `scripts/profile-browser.mjs`:
    `0c1d9973ceb4ca101cbbb587a7803fd86511b2dafa1ee919f29e854d659b5ce3`
  - `js/gl.js` (unmodified; recorded for provenance only):
    `b04bb784b87b17c8fe328b6f0a0b1cefdc50283a90d6d7c89b0a16e8521696b8`
  - `examples/browser_perf.rs`:
    `26089b534c33cf89c4b619c28af7effe6300e89a846459c876de4080720ce785`
    (unchanged since §1-§5; no Rust source changed in this revision)
  - `experiments/allocation-profile/src/core.rs`:
    `39ada104ccdddc2127c30099f3bc82c15801fc7fd3b8a6b7bb54e9c579bc7f47`
  - `experiments/allocation-profile/src/lib.rs`:
    `7dc94b1b196c4ee718feef10aaa9e6f262f0e9e44eb4f2d0ca0c02c2cc8e8826`
  - Built artifact, alloc-profile WASM (reused from §5; sources above are
    unchanged, so it was not rebuilt for this run):
    `72ae8db300f076add0c577485154be0f82cba8d33433169db7a84133cfd0d906`
- Raw JSON receipt retained as a session artifact at
  `files/performance-evidence/browser-profile-1794393432967-final-postmerge.json`
  (SHA-256 `47fc12e220500c5399e935511d25395167ba65f56313652515d7856a34728141`),
  not committed to the repository.
- Git history at handoff (`feat/allocation-proof`, newest first):
  `7ca0415` (merge of `origin/master`'s `cf238ff` into this branch),
  `1a567ac` (§5's fix), `78474f4` (§4's fix), `4b4b819` (shared-allocator
  rewrite), `73decfa` (the initial, not-accepted receipt). Not pushed;
  no PR opened; `master` was not modified.
- **Honest limits carried into this final run, unchanged:** same shared
  non-dedicated host (no timing/speed claim); Chromium/SwiftShader only,
  Firefox and WebKit were not run for this workload; no GPU-completion
  timer; single-threaded counting allocators only; the within-pass
  bind-cache counterfactual still cannot demonstrate cross-frame dedup
  (§3); the delete/recreate probe still cannot force or verify GL/driver
  GLuint numeric-name reuse (§3); the freeze-time pixel-capture fix (§4)
  remains an empirically-verified, not spec-guaranteed, timing property of
  the current `js/gl.js` render loop. This run adds no new unresolved
  limitation; it only confirms §§4-5's fixes hold after the `master`
  merge, on the real exported counters/pixel data, not a simulated or
  cached result.

## 7. Exact frame-boundary fix for windowA/windowB (this revision)

**What §6 and earlier runs got wrong.** `runAllocationProfile` determined
`windowA`/`windowB` boundaries with `page.waitForFunction(() =>
frameIntervals.length >= n, { polling: 50 })` followed by a *separate*
`page.evaluate()` call to read the real counters. Between the
`waitForFunction` resolving and the `evaluate` round-trip actually landing,
the page's own `requestAnimationFrame` loop kept running — so more frames
than intended could elapse before Node read the counters, silently
producing windows that were not exactly the claimed 30 frames long. This
is a genuine race, not a sampling-interval limitation: an observed
93-vs-87 alloc-call difference between two "30-frame" windows is
consistent with the windows actually being 31 and 29 frames, not an
allocation-behavior difference. §§1-6 above did not detect this because
their reported deltas happened to be consistent with exactly 30-frame
windows on those particular runs, not because the old code guaranteed it.
**This means §§2 and 6's windowA/windowB tables above are not proven to
have been measured over exactly-equal windows; they are superseded by the
exact-boundary receipt below, not erased** — the underlying allocator
counters and overall methodology they describe remain accurate, but their
specific claim of "equal 30-frame windows" was not actually enforced by
the code at the time.

**The fix.** Snapshot-taking was moved into `pageInstrumentation`'s own
`requestAnimationFrame` override, which already runs synchronously
in-page at the exact instant `frameIntervals.length` reaches a given
count (the same precedent already used for freeze-frame pixel capture and
bind-mode configuration). A new exported `ALLOC_WINDOW_PLAN` lists the
four exact frame boundaries (`windowAStart@60`, `windowAEnd@90`,
`windowBStart@90`, `windowBEnd@120`); the override captures each
boundary's real counters (resetting peak where required) the instant its
frame is reached, and throws a fatal error — recorded in
`window.__perf.fatalError`, never silently skipped — if the required
`wasm_exports.alloc_profile_*` exports are missing. Node now reads
`window.__perf.allocWindowSnapshots` at any later, arbitrarily-delayed
point (after the existing freeze-or-fatal-error wait) and still gets exact
values, because the snapshot was already taken synchronously, at the
right frame, in-page, regardless of when Node later gets around to
reading it. A new exported
`buildAllocationWindows(snapshots)` asserts every snapshot is present at
its exact plan frame and that both windows are exactly 30 frames long and
adjacent with zero gap/overlap, throwing descriptive errors — never
clamping — otherwise. The report now includes explicit
`windowA.startFrame`/`endFrame` and `windowB.startFrame`/`endFrame`.
`main()`'s `server.close()` was also moved into a `finally` block around
the measurement phase, so the listening socket is always released even
when a measurement throws (previously it was only closed on the success
path).

Regression coverage added in `tests/profile-browser.test.mjs`: (1) driving
180 simulated frames — far past every plan boundary and even past
`freezeFrame` itself, simulating an arbitrarily delayed Node-side read —
and asserting every snapshot's recorded frame still exactly matches its
plan entry; (2) asserting the override throws and records `fatalError`
instead of silently skipping a boundary when the required `wasm_exports`
exports are missing; (3) asserting `buildAllocationWindows` throws on a
missing snapshot and on an off-by-one overshot snapshot frame (the
regression case for the former `waitForFunction(>=n)` race), rather than
silently accepting an inexact window. These three tests were confirmed to
fail against the pre-fix source (`ALLOC_WINDOW_PLAN` does not exist there,
so the import itself fails) before being satisfied by the fix, proving
they exercise genuinely new behavior.

Verified on commit `289aad51671ab28e7b105342ebad74f27971b58b`:

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo test --lib
# => 10 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check --target wasm32-unknown-unknown --lib
# => Finished (no errors)

node --test tests/*.test.cjs tests/profile-browser.test.mjs
# => tests 99, pass 99, fail 0 (96 pre-existing + 3 new)

node scripts/check-docs.mjs
# => Documentation paths, decision statuses, and skill pointers passed.
```

Three-pair harness run against this exact committed revision (no Rust
source changed this round, so the already-built alloc-profile WASM
artifact's recorded source hashes are unchanged from §6):

```sh
PATH="$HOME/.cargo/bin:$PATH" \
GITHUB_SHA=289aad51671ab28e7b105342ebad74f27971b58b \
MINIQUAD_RUSTC_VERSION="rustc 1.99.0 (b940084d7 2026-09-28)" \
MINIQUAD_PLAYWRIGHT_ENTRY="$PLAYWRIGHT_ENTRY" \
MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs
```

The receipt's own `sourceRevision`/`rustcVersion` fields echoed back
exactly the `GITHUB_SHA`/`MINIQUAD_RUSTC_VERSION` above. The new
`allocationProfile.windowA`/`windowB` fields report **exact** boundaries:
`windowA: {startFrame: 60, endFrame: 90, delta: {allocCalls: 90,
reallocCalls: 0, deallocCalls: 90, liveBytesDelta: 0}}` and
`windowB: {startFrame: 90, endFrame: 120, delta: {allocCalls: 90,
reallocCalls: 0, deallocCalls: 90, liveBytesDelta: 0}}` — both windows are
provably exactly 30 frames (`endFrame - startFrame === 30`), adjacent
(`windowA.endFrame === windowB.startFrame === 90`), with an equal
allocCalls/deallocCalls total and a signed `liveBytesDelta` of `0` in each
(this is a real, equal-count, same-window observation on this run; it is
not a general "no leak" claim, consistent with §2/§6's existing caveat).
All 5 pixel comparisons (3 timing-pair `pixelParity` entries,
`bindCacheCounterfactual.withinPassSequence.pixelParity`, and
`deleteRecreateProbe.pixelParityVsRepeat`) reported `equalSize: true,
maxChannelDiff: 0, mismatchedPixelRatio: 0`. No speed/timing verdict is
drawn from this run.

> **Correction (see §8): this claim was false.** The raw receipt
> referenced below actually recorded `maxChannelDiff: 255,
> mismatchedPixelRatio: 0.252031` for all 3 timing-pair `pixelParity`
> entries; only `withinPassSequence.pixelParity` and
> `deleteRecreateProbe.pixelParityVsRepeat` were genuinely zero-diff. This
> was caught before any push/PR. §8 below documents the actual root
> cause (a contaminated `BASELINE_WASM` build) and a corrected,
> independently-verified receipt. This paragraph is left as originally
> written, not rewritten, so the mistake and its correction are both on
> the record.

- Source/artifact SHA-256 for this run (from the receipt's own
  `sourceProvenance`, independently reproduced via `shasum -a 256` on the
  committed tree):
  - `scripts/profile-browser.mjs`:
    `c1a3a9f20af8af4dafc519def487a9650653028277c647faec17ada4d377d3eb`
  - `js/gl.js` (unmodified; recorded for provenance only):
    `b04bb784b87b17c8fe328b6f0a0b1cefdc50283a90d6d7c89b0a16e8521696b8`
  - `examples/browser_perf.rs` (unchanged since §1-§6):
    `26089b534c33cf89c4b619c28af7effe6300e89a846459c876de4080720ce785`
  - `experiments/allocation-profile/src/core.rs` (unchanged since §4):
    `39ada104ccdddc2127c30099f3bc82c15801fc7fd3b8a6b7bb54e9c579bc7f47`
  - `experiments/allocation-profile/src/lib.rs` (unchanged since §4):
    `7dc94b1b196c4ee718feef10aaa9e6f262f0e9e44eb4f2d0ca0c02c2cc8e8826`
  - Built artifact, alloc-profile WASM (rebuilt this round from the
    unchanged sources above, to confirm reproducibility; hash unchanged
    from §6):
    `72ae8db300f076add0c577485154be0f82cba8d33433169db7a84133cfd0d906`
- Raw JSON receipt retained as a session artifact at
  `files/performance-evidence/browser-profile-1794397648899.json`
  (SHA-256
  `b499579aee590b048c14002d7898797fe1ac11be9462f8159cd6c4ed34f4fd93`),
  not committed to the repository.
- Git history at handoff (`feat/allocation-proof`, newest first):
  `289aad5` (this round's exact-window-boundary fix), `7ca0415` (local
  master merge), `1a567ac` (§5's fix), `78474f4` (§4's fix), `4b4b819`
  (shared-allocator rewrite), `73decfa` (the initial, not-accepted
  receipt). Not pushed; no PR opened; `master` was not modified.
- **Honest limits carried into this run, unchanged:** same shared
  non-dedicated host (no timing/speed claim); Chromium/SwiftShader only;
  no GPU-completion timer; single-threaded counting allocators only; the
  within-pass bind-cache counterfactual still cannot demonstrate
  cross-frame dedup (§3); the delete/recreate probe still cannot force or
  verify GL/driver GLuint numeric-name reuse (§3). The equal-count,
  zero-`liveBytesDelta` observation above is specific to this run's
  workload and frame count; it is not a general proof of no allocator
  growth under other workloads or longer runs.

## 8. Correction: baseline/candidate pixel-parity false claim, root cause, and verified fix

**The false claim.** §7 above claimed "All 5 pixel comparisons ... reported
`equalSize: true, maxChannelDiff: 0, mismatchedPixelRatio: 0`." This was
false. The actual raw receipt
(`browser-profile-1794397648899.json`, commit `df89920`) recorded, for
all 3 timing-pair `pixelParity` entries: `{"equalSize": true,
"maxChannelDiff": 255, "mismatchedPixelRatio": 0.252031}`. Only
`bindCacheCounterfactual.withinPassSequence.pixelParity` and
`deleteRecreateProbe.pixelParityVsRepeat` were genuinely
`{maxChannelDiff: 0, mismatchedPixelRatio: 0}`. This was caught by
direct inspection of the raw JSON before any push or PR, exactly the
kind of check this document is supposed to reflect having been done.

**Root cause.** §7's rebuild step to "confirm reproducibility" ran:

```sh
RUSTFLAGS="--cfg miniquad_alloc_profile" cargo build --release \
  --target wasm32-unknown-unknown --example browser_perf
```

without the required `--target-dir target/alloc-profile-experiment`
(see §4's/this document's own documented command, and
`docs/browser-profiling.md`). Cargo's default target dir for that
command is `target/wasm32-unknown-unknown/release/examples/`, which is
*exactly* `BASELINE_WASM`'s path in `scripts/profile-browser.mjs`. That
single missing flag silently overwrote the real baseline build with the
`alloc_profile`-cfg-gated one: confirmed by parsing the resulting WASM
with `WebAssembly.Module` and inspecting its real export table, which
contained `alloc_profile_available` and 15 other `alloc_profile_`-
prefixed exports (a default, no-cfg baseline build must never contain
any of them; see `docs/browser-profiling.md`'s own statement that such a
build "exposes zero `alloc_profile_*` WASM exports"). This manual,
one-off investigation step is distinct from (and is what motivated) the
now-formalized `assertNotAllocProfileContaminated` guard described under
"Fix" below, which runs this same real-export check automatically on
every harness run.

**Correction to this paragraph's original pixel-cause claim:** this
document originally stated the mismatch came from an internal startup
self-test changing rendered pixels. That is not the actual mechanism.
`examples/browser_perf.rs`'s `draw()` (see lines ~472-490) uses two
different texture-binding code paths selected by the same
`miniquad_alloc_profile` cfg that gates the self-test:
- the ordinary (`#[cfg(not(miniquad_alloc_profile))]`) path alternates
  `self.bindings.images[0]` between `texture_a`/`texture_b` every frame
  by `self.frame_index % 2`;
- the cfg-gated path instead calls `apply_alloc_profile_bindings()`,
  whose `bind_sequence()` loop is documented in its own comment as
  intentionally ending on `texture_a` in **both** repeat (`A,A,A,A`) and
  alternate (`A,B,B,A`) bind-count modes, specifically so that mode does
  not change rendered pixels relative to itself.
At the harness's frozen comparison frame (draw index 119, odd), the
ordinary build's `frame_index % 2` lands on `texture_b`, while the
contaminated cfg build's bindings always end on `texture_a` regardless
of frame parity. That texture-A-vs-texture-B difference, not the
self-test, is what changed the rendered pixels relative to
`CANDIDATE_WASM` (a real, unmodified-logic build at `-C opt-level=z`),
producing the observed `mismatchedPixelRatio: 0.252031` -- a real,
reproducible build-provenance defect, not a flaky run, not a tolerance
problem, and not a bug in §7's windowA/windowB fix itself (that fix's
own exact-frame-boundary results, reported in §7, remain correct and are
reproduced again below).

**Fix.** Rebuilt all three WASM artifacts with the exact commands
documented in `docs/browser-profiling.md`:

```sh
# BASELINE_WASM: default target dir, no cfg
cargo build --release --target wasm32-unknown-unknown --example browser_perf

# CANDIDATE_WASM: -C opt-level=z, separate target dir
RUSTFLAGS="-C opt-level=z" CARGO_TARGET_DIR=target/profiling-experiment \
  cargo build --release --target wasm32-unknown-unknown --example browser_perf

# ALLOC_PROFILE_WASM: --cfg, separate target dir
RUSTFLAGS="--cfg miniquad_alloc_profile" cargo build --release \
  --target wasm32-unknown-unknown --example browser_perf \
  --target-dir target/alloc-profile-experiment
```

Verified directly after rebuilding, by parsing each artifact with
`WebAssembly.Module` and inspecting its real export table: `BASELINE_WASM`
and `CANDIDATE_WASM` export no `alloc_profile_`-prefixed name;
`ALLOC_PROFILE_WASM` still exports 16 of them, starting with
`alloc_profile_available` (as intended, it is a separate, deliberately
instrumented artifact, never used for the baseline/candidate timing-pair
comparison).

Added an exported guard, `assertNotAllocProfileContaminated(wasmBytes,
label)` (`scripts/profile-browser.mjs`), called on both `BASELINE_WASM`
and `CANDIDATE_WASM` bytes in `main()` immediately after they are read,
before any size/pixel/timing comparison runs. It parses the bytes with
`new WebAssembly.Module(wasmBytes)` and checks
`WebAssembly.Module.exports(module)` for any export name starting with
`alloc_profile_`, so a marker string that merely appears in a
custom/data section (not a real export) cannot cause a false positive,
and it throws explicitly -- naming the offending export -- if
contamination is real, and throws explicitly (a distinct, clearly
labeled parse error) if the bytes are not a valid WASM module at all,
rather than silently treating either case as clean. This exact class of
mistake (a misdirected or overwritten build silently corrupting the
baseline/candidate comparison) can no longer produce a misleading
result. Added 4 regression tests (`tests/profile-browser.test.mjs`),
each built on real, hand-assembled, valid minimal WASM modules (not
byte-string stand-ins): the guard throws when a module genuinely exports
an `alloc_profile_`-prefixed name; it does **not** throw when that exact
marker string appears only inside a custom section's payload (proving
the export-table check, not a raw scan, is what runs); it does not throw
on a clean module with an unrelated export; and it throws an explicit,
distinct "not a valid WASM module" error on malformed bytes. Also
independently re-verified the guard against the real on-disk contaminated
`target/alloc-profile-experiment` WASM (throws, naming
`alloc_profile_available`) and the real on-disk corrected
`BASELINE_WASM` (does not throw).

Verified on commit `202a38aa0f55bbc318749aa9a7b41fa9e7ba31cb`:

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo test --lib
# => 10 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check --target wasm32-unknown-unknown --lib
# => Finished (no errors)

node --test tests/*.test.cjs tests/profile-browser.test.mjs
# => tests 101, pass 101, fail 0 (99 previous + 2 new)

node scripts/check-docs.mjs
# => Documentation paths, decision statuses, and skill pointers passed.
```

Three-pair harness re-run against this exact commit, with the
contamination guard active and all three WASM artifacts freshly rebuilt
with the correct, documented commands above:

```sh
PATH="$HOME/.cargo/bin:$PATH" \
GITHUB_SHA=202a38aa0f55bbc318749aa9a7b41fa9e7ba31cb \
MINIQUAD_RUSTC_VERSION="rustc 1.99.0 (b940084d7 2026-09-28)" \
MINIQUAD_PLAYWRIGHT_ENTRY="$PLAYWRIGHT_ENTRY" \
MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs
```

The receipt's own `sourceRevision`/`rustcVersion` echoed back exactly the
`GITHUB_SHA`/`MINIQUAD_RUSTC_VERSION` above. All 5 pixel comparisons were
independently asserted, programmatically, against the raw JSON file
(`equalSize === true && maxChannelDiff === 0 && mismatchedPixelRatio ===
0` for each of the 3 timing-pair entries,
`bindCacheCounterfactual.withinPassSequence.pixelParity`, and
`deleteRecreateProbe.pixelParityVsRepeat`) and **all 5 passed** -- this
time genuinely, not merely asserted in prose. `allocationProfile.windowA`
= `{startFrame: 60, endFrame: 90, delta: {allocCalls: 90, reallocCalls: 0,
deallocCalls: 90, liveBytesDelta: 0}}`, `windowB` = `{startFrame: 90,
endFrame: 120, delta: {allocCalls: 90, reallocCalls: 0, deallocCalls: 90,
liveBytesDelta: 0}}` -- identical to §7's own windowA/windowB values,
confirming the exact-frame-boundary fix itself was never the source of
the pixel-parity defect. No speed/timing verdict is drawn from this run.

- Source/artifact SHA-256 for this corrected run (from the receipt's own
  `sourceProvenance`, independently reproduced via `shasum -a 256` on the
  committed tree and the rebuilt WASM artifacts):
  - `scripts/profile-browser.mjs`:
    `93b9e317c66eb8d612c8dd70da48b5a4030e30d8fe0b32731eb95a9123ce0761`
  - `js/gl.js` (unmodified; recorded for provenance only):
    `b04bb784b87b17c8fe328b6f0a0b1cefdc50283a90d6d7c89b0a16e8521696b8`
  - `examples/browser_perf.rs` (unchanged since §1-§7):
    `26089b534c33cf89c4b619c28af7effe6300e89a846459c876de4080720ce785`
  - `experiments/allocation-profile/src/core.rs` (unchanged since §4):
    `39ada104ccdddc2127c30099f3bc82c15801fc7fd3b8a6b7bb54e9c579bc7f47`
  - `experiments/allocation-profile/src/lib.rs` (unchanged since §4):
    `7dc94b1b196c4ee718feef10aaa9e6f262f0e9e44eb4f2d0ca0c02c2cc8e8826`
  - `BASELINE_WASM` (`target/wasm32-unknown-unknown/release/examples/
    browser_perf.wasm`, rebuilt, no `alloc_profile_available` marker):
    `ca4d6e04b0b5fe54c76ab44525fffafe2b2563ed1cab7f5e518da491838dcd88`
  - `CANDIDATE_WASM` (`target/profiling-experiment/wasm32-unknown-unknown/
    release/examples/browser_perf.wasm`, rebuilt, no
    `alloc_profile_available` marker):
    `675e244d9a4919729673619371efa1dfe92ef91e6ec855697d2620b3ec0a1f8f`
  - `ALLOC_PROFILE_WASM` (`target/alloc-profile-experiment/
    wasm32-unknown-unknown/release/examples/browser_perf.wasm`, rebuilt,
    correctly retains the `alloc_profile_available` marker; hash
    unchanged from §6-§7):
    `72ae8db300f076add0c577485154be0f82cba8d33433169db7a84133cfd0d906`
- Raw JSON receipts retained as session artifacts (neither committed to
  the repository):
  - The **incorrect** run that led to the false claim:
    `files/performance-evidence/browser-profile-1794397648899.json`
    (SHA-256
    `b499579aee590b048c14002d7898797fe1ac11be9462f8159cd6c4ed34f4fd93`) --
    kept, not deleted, so the false claim's source data remains
    inspectable.
  - The **corrected** run documented in this section:
    `files/performance-evidence/browser-profile-1794398500593.json`
    (SHA-256
    `4fab225c878bae70faf1883f3ee1fb6039a4b1d4c419e7ba8e29d8068d0be7b7`).
- Git history at handoff (`feat/allocation-proof`, newest first):
  `202a38a` (this section's contamination guard + regression tests),
  `df89920` (§7's docs, since corrected by this section), `289aad5`
  (§7's exact-window-boundary fix), `7ca0415` (local master merge),
  `1a567ac` (§5's fix), `78474f4` (§4's fix), `4b4b819` (shared-allocator
  rewrite), `73decfa` (the initial, not-accepted receipt). Not pushed; no
  PR opened; `master` was not modified.
- **Honest limits carried into this run, unchanged:** same shared
  non-dedicated host (no timing/speed claim); Chromium/SwiftShader only;
  no GPU-completion timer; single-threaded counting allocators only; the
  within-pass bind-cache counterfactual still cannot demonstrate
  cross-frame dedup (§3); the delete/recreate probe still cannot force or
  verify GL/driver GLuint numeric-name reuse (§3); the new contamination
  guard only detects a real `alloc_profile_`-prefixed WASM export, not
  every possible build-provenance mistake (for example, a stale but
  *uninstrumented* build from an older source revision would not be
  caught by this guard; §7/§8's `sourceProvenance` SHA-256 fields remain
  the authoritative, broader check for that).

## 9. Correction: §8's pixel-mismatch cause and the contamination guard's detection method

§8 above originally attributed the pixel mismatch to the `alloc_profile`
module's startup self-test. That paragraph has since been corrected
in-place (left visible, marked as corrected, not deleted): the real
mechanism is that the ordinary build's per-frame
`texture_a`/`texture_b` alternation (`frame_index % 2`) and the
cfg-gated `apply_alloc_profile_bindings()`'s bind sequence (which always
ends on `texture_a`) land on different textures at the harness's frozen
comparison frame (draw index 119, odd) -- see
`examples/browser_perf.rs`'s `draw()`, ~lines 472-490.

Also rewrote `assertNotAllocProfileContaminated`
(`scripts/profile-browser.mjs`) from a raw-byte substring scan (which
could false-positive on a marker in a non-export location, e.g. a
custom section, and did not reject malformed non-WASM bytes) to parse
each buffer with `new WebAssembly.Module(wasmBytes)` and check
`WebAssembly.Module.exports(module)` for any export name starting with
`alloc_profile_`, throwing an explicit, distinct error for malformed
bytes. Replaced the 2 byte-string-literal regression tests with 4 tests
built on real, hand-assembled, minimal valid WASM modules.

Verified on commit `022ca9049cd6fc3422fa7ab5360c226053f9c9e5`:

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo test --lib
# => 10 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check --target wasm32-unknown-unknown --lib
# => Finished (no errors)

node --test tests/*.test.cjs tests/profile-browser.test.mjs
# => tests 103, pass 103, fail 0 (99 unrelated prior + 4 new guard tests,
#    replacing the 2 prior byte-string ones)

node scripts/check-docs.mjs
# => Documentation paths, decision statuses, and skill pointers passed.
```

Re-ran the real three-pair harness natively (no Docker) against this
exact commit:

```sh
PATH="$HOME/.cargo/bin:$PATH" \
GITHUB_SHA=022ca9049cd6fc3422fa7ab5360c226053f9c9e5 \
MINIQUAD_RUSTC_VERSION="rustc 1.99.0 (b940084d7 2026-09-28)" \
MINIQUAD_PLAYWRIGHT_ENTRY="$PLAYWRIGHT_ENTRY" \
MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs
```

All 5 pixel comparisons were again individually asserted against the raw
JSON before writing this claim (`equalSize === true && maxChannelDiff
=== 0 && mismatchedPixelRatio === 0` for each of the 3 timing-pair
entries, `withinPassSequence.pixelParity`, and
`deleteRecreateProbe.pixelParityVsRepeat`) and **all 5 passed**.
`windowA`/`windowB` are unchanged from §8:
`{startFrame: 60, endFrame: 90, delta: {allocCalls: 90, reallocCalls: 0,
deallocCalls: 90, liveBytesDelta: 0}}` /
`{startFrame: 90, endFrame: 120, delta: {allocCalls: 90, reallocCalls: 0,
deallocCalls: 90, liveBytesDelta: 0}}`. `sourceRevision`/`rustcVersion`
echoed back exactly the env values above. No speed/timing verdict is
drawn from this run.

- Source/artifact SHA-256 for this run:
  - `scripts/profile-browser.mjs` (updated by this section's guard
    rewrite):
    `e5719ed2dc6665cefb7ab70b020fa2af19989fa5e594d878861e553aea35615a`
  - `js/gl.js`, `examples/browser_perf.rs`,
    `experiments/allocation-profile/src/{core,lib}.rs`: unchanged from
    §8.
  - `ALLOC_PROFILE_WASM`: unchanged from §6-§8,
    `72ae8db300f076add0c577485154be0f82cba8d33433169db7a84133cfd0d906`.
- Raw JSON receipt retained as a session artifact (not committed to the
  repository):
  `files/performance-evidence/browser-profile-1794399365011.json`
  (SHA-256
  `e638b35b1004550c4b5b09c88f5f2394785a8b8a5ea5741be52078f4850d8709`).
- Git history at handoff (`feat/allocation-proof`, newest first):
  `022ca90` (this section's §8 narrative correction and guard rewrite),
  `5873e8e` (§8/§7 false-claim correction), `202a38a` (contamination
  guard v1), `df89920` (§7's docs), `289aad5` (§7's exact-window-
  boundary fix), `7ca0415` (local master merge), `1a567ac` (§5's fix),
  `78474f4` (§4's fix), `4b4b819` (shared-allocator rewrite), `73decfa`
  (the initial, not-accepted receipt). Not pushed; no PR opened;
  `master` was not modified.
- **Honest limits, unchanged from §8:** same shared non-dedicated host
  (no timing/speed claim); Chromium/SwiftShader only; no GPU-completion
  timer; single-threaded counting allocators only; within-pass bind-
  cache cross-frame dedup and GLuint numeric-name reuse remain
  unverifiable (§3); the guard checks real WASM exports, not every
  possible provenance mistake (e.g. a stale-but-uninstrumented build);
  `sourceProvenance` SHA-256 fields remain the broader check for that.

## Explicitly not measured / acceptance notes

- No real GPU hardware timer or mobile/reference device was used.
  Firefox and WebKit were not run for this profiling workload.
- No speed/timing claim is made anywhere in this document, on this shared
  host or otherwise; every number above is a call count, byte count, or
  frame-window boundary, read directly from a real counting allocator or a
  real wrapped WebGL API.
- Cross-frame bind-cache dedup (as opposed to the within-pass
  counterfactual measured above) was not and cannot be measured by this
  fixture, because `commit_frame` clears the cache every frame; a
  different fixture structure would be needed and is out of this change's
  scope.
- Browser/driver GLuint numeric-name reuse after `glDeleteTextures` was not
  forced or independently verified; the delete/recreate probe shows the
  code path runs and renders correctly, not that name reuse specifically
  occurred.

## Acceptance matrix against issue #14

| #14 item | Status | Evidence |
| --- | --- | --- |
| Real Rust/WASM allocation profiling (not a rate) | **Done** | §1 (native, 5/5 tests) + §2 (real browser run, real counters + CDP sampling, two after-warmup windows) |
| Shared allocator source, no duplication | **Done (corrected this round)** | `experiments/allocation-profile/src/core.rs`, `include!`-d by both `lib.rs` and `examples/browser_perf.rs` |
| Benchmark-only allocator, outside core, no new runtime deps | **Done** | `experiments/allocation-profile/` (standalone crate) + `examples/browser_perf.rs` cfg-gated module; root `Cargo.toml` untouched |
| WASM allocations as real requested bytes, not page surrogate | **Done** | §1/§2 tables report `Layout::size()`-derived byte counts, not `memory.grow` page counts |
| Bounded scalar counters exported from fixture, no JS forging | **Done** | `#[no_mangle]` scalar getters; JS only reads, via existing `wasm_exports` |
| Signed, validated counter deltas (no clamping, no silent error) | **Done (corrected this round)** | `delta()`'s `AllocDeltaError` on backwards call counts; honest negative `liveBytesDelta`/`peakBytesDelta` when legitimate (§1 tests) |
| CDP heap sampling correctly scoped to JS heap, not claimed for Rust allocations | **Done (corrected this round)** | §2's CDP paragraph |
| Upstream `#682` buffer-upload semantics reviewed via real PR | **Done** | §3 table, `gh pr view --repo not-fl3/miniquad 682` |
| Upstream `#691` correctly understood as deletion-cache invalidation + real within-pass dedup counterfactual | **Done (corrected this round)** | §3; harness bug found, fixed, and documented; real differing bind counts measured |
| No fabricated timing/rate claims; shared-host caveats preserved | **Done** | All counts above are call/byte counts; existing timing-pair verdicts from 2026-11-11-browser-profile.md are unchanged by this document |
| Cross-engine corroboration | **Not attempted** | Harness is Chromium/CDP-only by design (`HeapProfiler`/`Profiler` are CDP-specific); explicitly out of scope per task instructions, not claimed |
| Exact, race-free windowA/windowB frame boundaries (not an async-poll race) | **Done (corrected this round)** | §7; synchronous in-page snapshot via `ALLOC_WINDOW_PLAN` + `buildAllocationWindows`, with regression tests proving the fix against the old race |

## Test commands and results (this change)

```sh
# Native allocation-profiling crate
PATH="$HOME/.cargo/bin:$PATH" \
  cargo test --manifest-path experiments/allocation-profile/Cargo.toml -- --test-threads=1
# => 5 passed; 0 failed

# miniquad library unit tests (unaffected by this change)
PATH="$HOME/.cargo/bin:$PATH" cargo test --lib
# => 10 passed; 0 failed

# wasm32 lib check
PATH="$HOME/.cargo/bin:$PATH" cargo check --target wasm32-unknown-unknown --lib
# => Finished (no errors)

# JS pure-function tests, including this file's allocation-profiling helper tests
node --test tests/*.test.cjs tests/profile-browser.test.mjs
# => tests 86, pass 86, fail 0

# Documentation/decision-record link check
node scripts/check-docs.mjs
# => Documentation paths, decision statuses, and skill pointers passed.

# rustfmt, touched files only (whole-crate `cargo fmt --check` reports
# unrelated pre-existing drift in src/graphics/metal.rs, out of this
# change's scope; not run as a gate here for that reason)
rustfmt --check examples/browser_perf.rs
rustfmt --check experiments/allocation-profile/src/lib.rs experiments/allocation-profile/src/core.rs
# => both clean (no diff)

# Full harness (allocation profile + bind-cache counterfactual; timing
# pairs reported separately in 2026-11-11-browser-profile.md)
MINIQUAD_PROFILE_PAIRS=3 node scripts/profile-browser.mjs
# => wrote raw receipt (see above); all sections populated, no crash/timeout
#    on this run
```

`npm run lint:js` was not run for this change: it lints `js/gl.js` and
`js/*.mjs` only, neither of which this change touches.
