# Deprecate the unverified `ElapsedQuery` timer API

* Status: **Accepted**
* Date: 2026-11-11
* Tracking: [#145](https://github.com/Tigon32/miniquad/issues/145); parent audit [#141](https://github.com/Tigon32/miniquad/issues/141); earlier record in closed [#13](https://github.com/Tigon32/miniquad/issues/13)
* Source: `8a96be961ba5f26a55d969c3343e400d77a1d931`
* Scope: `ElapsedQuery` in `src/graphics.rs`
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

`ElapsedQuery` is a public API for GPU timer queries.
Its documentation tells a caller to call `is_supported()` before using the other methods.

The current code does not meet that contract:

* `is_supported()` calls `unimplemented!()`. It panics on every backend.
* `get_result()` always returns `0`. `is_available()` always returns `false`.
  These are success-shaped values. A caller cannot tell a real zero-length
  query from a query that never ran.
* `begin_query()`, `end_query()`, and `delete()` call GL functions directly
  (`glGenQueries`, `glBeginQuery`, `glEndQuery`, `glDeleteQueries`).
  These functions are `Option<extern "C" fn(..)>` statics. Native code only
  fills them in `load_gl_funcs`, which the GL and WebGL backends call during
  context creation. The Metal backend never calls `load_gl_funcs`. A call to
  any of these functions on Metal unwraps a `None` and panics.
* `is_supported()` is a static method. It has no `&self` and no context
  argument, so it cannot read `RenderingBackend::info()` to find the active
  backend. It has no safe way to know whether the GL functions are loaded.

The GL query functions exist in `js/gl.js` for the browser, and `get_result`/
`is_available` have commented-out GL calls for a native path. Even if we
restored those calls, the combination never produced a correct result on any
backend, because `get_result()` and `is_available()` stayed hard-coded.
No backend has ever had a complete, truthful implementation of this API.

## Decision Drivers

* `is_supported()` must return a value without a panic on GL, WebGL, and
  Metal contexts ([#145](https://github.com/Tigon32/miniquad/issues/145)).
* An unsupported operation must not return a success-shaped `0` or `false`.
* Do not call an unloaded GL function from a static method with no backend
  context (native-safety skill: static `ElapsedQuery` methods cannot safely
  call unloaded GL on Metal).
* Do not add a new cross-backend timing system or a performance claim in
  this change. A real GPU timer implementation needs its own proof, matching
  [MADR 0002](0002-risk-based-verification-and-selective-tdd.md) and the
  performance-proof skill.
* Keep the Rust MSRV `1.70` and the existing public dependencies.
* Prefer the smallest truthful fix for an incomplete public API
  ([MADR 0014](0014-minimal-code-comments-and-tracked-work.md)).

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Wire a real cross-backend implementation now (GL, WebGL, Metal) | Callers get a working timer | Needs a Metal GPU timer path, `RenderingBackend` plumbing, and real hardware/browser proof. Out of scope for a P3 contract fix; risks an unproven performance claim. |
| Make `is_supported()` probe the loaded GL function pointers directly | Small code change | A static method still has no reliable way to know the active backend without new global state. Probing `Option` pointers from outside the `gl` module is fragile and does not fix `get_result`/`is_available`. |
| **Deprecate the whole API as unsupported in this release** | Matches the real, verified state on every backend. Removes the panic and the success-shaped placeholders. No new design or proof needed. | Callers lose a currently broken feature. A future MADR must re-introduce it with real backend plumbing. |

## Decision Outcome

**Accepted:** deprecate `ElapsedQuery` for this release.

* `is_supported()` returns `false` on every backend. It never panics and
  never calls a GL function.
* `begin_query()`, `end_query()`, `get_result()`, `is_available()`, and
  `delete()` panic with a message that names issue #145 and tells the
  caller to check `is_supported()` first. A panic on misuse is not a
  success-shaped value; `is_supported()` already told the caller not to
  call these methods.
* The struct and its methods carry `#[deprecated]` with a note that points
  to this record and the tracking issue.
* The doc comments stop telling the caller that a supported path exists.
  They record the current unsupported state and the tracking issue.

A later MADR can re-introduce a verified implementation. That MADR needs a
real GPU timer path for Metal, `RenderingBackend` plumbing so `is_supported()`
can read the active backend safely, and proof on GL, WebGL, and Metal
following the performance-proof skill.

## Consequences

### Positive

* `is_supported()` matches its contract: a caller can call it without a
  panic on any backend.
* No method returns a value that looks like a real measurement when no
  measurement ran.
* The fix stays inside `src/graphics.rs`. It needs no new dependency, no
  Metal GPU timer code, and no performance claim.

### Negative

* `ElapsedQuery` has no working path on any backend until a follow-up MADR
  and implementation land.
* A caller that ignored `is_supported()` and called the other methods now
  gets a panic instead of a placeholder value. This is a breaking behavior
  change for that misuse case. The public shape (method names and
  signatures) does not change.

## Confirmation

1. `is_supported()` returns `false` and does not panic, tested without a
   graphics context.
2. `begin_query()`, `end_query()`, `get_result()`, `is_available()`, and
   `delete()` panic, tested without a graphics context.
3. `cargo test --lib` and `cargo check --target wasm32-unknown-unknown --lib`
   pass.

## References

* [Issue #145](https://github.com/Tigon32/miniquad/issues/145)
* [Issue #141](https://github.com/Tigon32/miniquad/issues/141)
* [MADR 0002 — Risk-based verification](0002-risk-based-verification-and-selective-tdd.md)
* [MADR 0014 — Minimal code comments](0014-minimal-code-comments-and-tracked-work.md)
* [Native safety skill](../../.github/skills/miniquad-native-safety/SKILL.md)
* [Performance proof skill](../../.github/skills/miniquad-performance-proof/SKILL.md)
