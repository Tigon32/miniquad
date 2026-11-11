# Add a verified WebGL2 GPU timer-query path and supersede the deprecation

* Status: **Accepted**
* Date: 2026-11-11
* Tracking: [#145](https://github.com/Tigon32/miniquad/issues/145); related [#157](https://github.com/Tigon32/miniquad/issues/157)
* Source: `2ff0073837e9a33008f108f7b4a7ea5c3ed2ae66`
* Supersedes: [MADR 0021](0021-deprecate-unverified-elapsed-query.md)
* Scope: `ElapsedQuery` in `src/graphics.rs`, `src/native/gl.rs`, `src/native/wasm/webgl.rs`, `js/gl.js`
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

[MADR 0021](0021-deprecate-unverified-elapsed-query.md) deprecated `ElapsedQuery`
for the whole library. It made `is_supported()` return `false` on every
backend and made the other methods panic. That record said a later decision
could add a real GPU timer path, with backend plumbing and proof.

The maintainer's later comment on
[issue #145](https://github.com/Tigon32/miniquad/issues/145) (2026-11-11T16:14:30Z)
asks for more than a safe panic. It asks for:

* The WebGL loader to request the `EXT_disjoint_timer_query_webgl2`
  extension on a WebGL2 context.
* `is_supported()` to report a real value without a panic, read from the
  active backend.
* A WebGL2 query to return a nonzero result in Chromium on a hardware
  graphics adapter (not a software adapter such as SwiftShader).
* An unsupported context to report "unsupported," not `0`.

A blanket deprecation (MADR 0021) cannot satisfy this. It never returns a
real measurement on any backend. This record replaces that blanket
deprecation with a real, verified path on the one backend the WebGL2 core
specification provides an extension for: `EXT_disjoint_timer_query_webgl2`.

[Issue #157](https://github.com/Tigon32/miniquad/issues/157) tracks proof
that Miniquad gives value over plain WebGL2 calls. It lists GPU-time
measurement as one input to that proof. This record gives the first
verified GPU-time source that a future #157 measurement can use; it does
not itself answer #157.

## Decision Drivers

* Honor the maintainer's explicit nonzero-result requirement for #145.
* Do not add a cross-backend timing system in one change; keep the proof
  real and narrow ([MADR 0002](0002-risk-based-verification-and-selective-tdd.md)).
* Do not return a success-shaped `0` or `false` for an unsupported,
  pending, or disjoint query, matching MADR 0021's original driver.
* Do not call an unloaded GL function from a context-free static method
  (native-safety skill); the new `is_supported()` must read the active
  `Backend` safely on every target, including Metal.
* Keep the public WASM ABI import/export surface unchanged where an
  existing import already does the job; change `docs/abi-v3-contract.md`
  and `docs/abi-v3-function-inventory.md` only if a new or changed import
  is required ([WASM ABI skill](../../.github/skills/miniquad-wasm-abi/SKILL.md)).
* Give real browser evidence for the WebGL2 nonzero claim
  ([performance-proof skill](../../.github/skills/miniquad-performance-proof/SKILL.md)),
  not a native unit-test assertion alone.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep MADR 0021's blanket deprecation | No new code; matches the already-merged, already-tested PR #169 | Does not meet the maintainer's explicit #145 requirement for a nonzero WebGL2 result; leaves `ElapsedQuery` permanently non-functional |
| Add a full cross-backend timer (native GL `ARB_timer_query`, WebGL1 `EXT_disjoint_timer_query`, WebGL2 `EXT_disjoint_timer_query_webgl2`, and a Metal `MTLCounterSampleBuffer` path) | One API with support almost everywhere | Needs a new Metal GPU-counter subsystem with its own proof on real Apple hardware; needs native-GL proof across multiple drivers; far larger than the #145 contract fix; risks an unproven performance claim across backends in one change |
| **Add only the WebGL2 `EXT_disjoint_timer_query_webgl2` path; keep native GL, Metal, WebGL1, and an unavailable extension as explicit `ElapsedQueryError::Unsupported`** | Meets the #145 nonzero-result requirement with one real, provable backend; the capability probe and the disjoint-flag read reuse WASM imports (`glGetQueryiv`, `glGetIntegerv`) already declared and documented for ABI v3, so no ABI version bump is needed; native GL and Metal keep the "no panic, explicit unsupported" guarantee from MADR 0021 | Native desktop OpenGL actually has `ARB_timer_query` as a core 3.3 feature; this record does not use it, so a caller on a native desktop build still gets `Unsupported` even though hardware support may exist there. A future MADR may add it with its own native-GL proof. |
| Pass `&dyn RenderingBackend` instead of a `Backend` value to every `ElapsedQuery` method | Matches MADR 0021's "RenderingBackend plumbing" wording literally | `RenderingBackend` has over 40 methods; a full mock trait object for unit tests is disproportionate to this fix. `Backend` (the enum already returned by `RenderingBackend::info().backend`) gives the same backend-aware safety with a much smaller, directly testable surface. |

## Decision Outcome

**Accepted:** add a real WebGL2 GPU timer-query path; keep every other
backend and context as an explicit unsupported state.

* `ElapsedQuery::is_supported(backend: Backend) -> bool` takes the active
  backend and never panics. On native OpenGL and Metal it returns `false`
  without touching a GL function pointer. On the `wasm32` target it calls
  `glGetQueryiv(GL_TIME_ELAPSED, GL_QUERY_COUNTER_BITS, &mut bits)` and
  returns `bits > 0`. This is the WebGL2 specification's own
  feature-detection idiom for `EXT_disjoint_timer_query_webgl2`: a WebGL1
  context (no `gl.getQuery`) and a WebGL2 context without the extension
  both return `0` bits; only a granted WebGL2 extension returns a nonzero
  bit count.
* `begin_query`, `end_query`, and `delete` keep MADR 0021's panic-on-misuse
  contract: calling them on an unsupported backend panics, naming
  `is_supported()` as the required check. This is not a success-shaped
  value; it is the same contract MADR 0021 already established and no
  caller in this repository depends on the old panic-free, always-`false`
  shape (confirmed by search: `ElapsedQuery` has no caller outside its own
  tests).
* `is_available(backend: Backend) -> Result<bool, ElapsedQueryError>` and
  `get_result(backend: Backend) -> Result<u64, ElapsedQueryError>` replace
  MADR 0021's panic-only contract for these two read methods with a typed
  `ElapsedQueryError`:
  * `Unsupported` — the backend or context has no verified timer path.
  * `NotReady` — the query has not finished; `get_result` must not be
    called yet (`is_available` itself returns `Ok(false)`, not an error, for
    this case; `NotReady` is for a caller that calls `get_result` too soon).
  * `Disjoint` — the browser reported `GPU_DISJOINT_EXT` while this query
    was outstanding; the timing value is not trustworthy.
  No branch returns `0` or `false` to mean "no real measurement."
* `js/gl.js` gains two small, non-ABI-affecting changes to make the above
  possible: (1) the WebGL2 context acquires
  `EXT_disjoint_timer_query_webgl2` (the call is required before the
  browser recognizes the `TIME_ELAPSED`/`QUERY_COUNTER_BITS` tokens, even
  when the returned extension handle is discarded) and defines
  `gl.getQueryObject` as a thin alias for the core `gl.getQueryParameter`,
  so the existing `glGetQueryObjectiv`/`glGetQueryObjectui64v` bridge
  functions work unchanged on WebGL2; (2) `glGetQueryiv` — already declared
  in `src/native/wasm/webgl.rs` and already documented in
  `docs/abi-v3-function-inventory.md`, but never implemented in the JS
  bridge — now has a real implementation, guarded by
  `typeof gl.getQuery === 'function'` so a WebGL1 context (which has no
  `getQuery` method) safely reports `0` instead of throwing.
* The disjoint flag (`GPU_DISJOINT_EXT`) is a one-shot, read-and-clear,
  context-wide flag. `is_available` reads it only after
  `GL_QUERY_RESULT_AVAILABLE` is confirmed true, not on every "not ready
  yet" poll. Reading it earlier could clear a real disjoint event before
  the query that spans it is checked.
* Native desktop/mobile OpenGL and Metal stay unsupported in this release,
  by design, not by a technical limit. `ARB_timer_query` is a real, core,
  native OpenGL 3.3 feature; a future MADR may add a native-GL path with
  its own loaded-pointer safety proof. Metal has no loaded timer-query
  entry point in this codebase and is out of scope here.

## Consequences

### Positive

* `ElapsedQuery` meets the #145 nonzero-result requirement on the one
  backend this record claims: WebGL2 with the extension granted.
* No WASM import or export changes; `docs/abi-v3-contract.md` and
  `docs/abi-v3-function-inventory.md` need no edit; `glGetQueryiv` was
  already a documented ABI v3 import, so filling in its JS implementation
  does not change the contract. `node scripts/check-abi-inventory.mjs`
  still passes unchanged.
* No caller-visible success-shaped placeholder remains for an unsupported,
  pending, or disjoint query.
* `ElapsedQuery` is no longer `#[deprecated]`; a verified path now exists.

### Negative

* The public method signatures change again, from MADR 0021's shape
  (`is_supported()` with no argument; `is_available`/`get_result` returning
  plain `bool`/`u64`) to a `Backend`-parameterized, `Result`-returning
  shape. This is a second breaking change to the same already-unstable,
  already-deprecated API inside one release cycle; confirmed low-risk
  because no caller in this repository used the MADR 0021 shape.
* Native desktop OpenGL, which has real hardware timer-query support in
  practice, still reports `Unsupported` in this release. A caller on a
  native build gets no GPU timing at all until a follow-up MADR.
* The nonzero-result proof needs a hardware-accelerated Chromium context
  (not a software adapter). A sandboxed or headless CI runner using
  SwiftShader cannot reproduce this proof; such an environment must report
  the acceptance test as blocked rather than claim a result.

## Confirmation

1. `cargo test --lib`: native OpenGL and Metal both report
   `is_supported() == false` without a panic; `is_available`/`get_result`
   both return `Err(ElapsedQueryError::Unsupported)`; `begin_query`,
   `end_query`, and `delete` panic on both backends.
2. `cargo check --target wasm32-unknown-unknown --lib` passes.
3. `node --check js/gl.js` and `npm run lint:js` pass.
4. `node scripts/check-abi-inventory.mjs` passes with no contract or
   inventory edits.
5. A real-browser Playwright test in a hardware-accelerated Chromium
   context (not SwiftShader) exercises the full `begin_query`/`end_query`/
   `is_available`/`get_result` lifecycle on a WebGL2 canvas and records a
   nonzero `u64` result, the extension name, and the GPU/driver string from
   `WEBGL_debug_renderer_info`. A parallel WebGL1 canvas records
   `ElapsedQueryError::Unsupported`. See the test evidence recorded in the
   pull request for this change.

## References

* [Issue #145](https://github.com/Tigon32/miniquad/issues/145)
* [Issue #157](https://github.com/Tigon32/miniquad/issues/157)
* [MADR 0002 — Risk-based verification](0002-risk-based-verification-and-selective-tdd.md)
* [MADR 0014 — Minimal code comments](0014-minimal-code-comments-and-tracked-work.md)
* [MADR 0021 — Deprecate the unverified `ElapsedQuery` timer API](0021-deprecate-unverified-elapsed-query.md) (superseded by this record)
* [Native safety skill](../../.github/skills/miniquad-native-safety/SKILL.md)
* [WASM ABI skill](../../.github/skills/miniquad-wasm-abi/SKILL.md)
* [Performance proof skill](../../.github/skills/miniquad-performance-proof/SKILL.md)
* [`EXT_disjoint_timer_query_webgl2` specification](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)
