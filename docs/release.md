# Browser release qualification

**Status:** Proposed policy, not a release approval.  
**Scope:** This fork of Miniquad, initially Rust package `miniquad` 0.4.11.  
**Tracking:** [#19](https://github.com/Tigon32/miniquad/issues/19), [#11](https://github.com/Tigon32/miniquad/issues/11), [#14](https://github.com/Tigon32/miniquad/issues/14), [#22](https://github.com/Tigon32/miniquad/issues/22).

## Compatibility commitments

Until a versioned fork release is approved, do not claim full upstream compatibility.

- **Rust API:** Treat the exported library API in `src/lib.rs`, `src/event.rs`, and `src/graphics.rs` as the compatibility review surface. Review public item signatures and behavioral changes against the previous qualified tag. Preserve compatibility unless a documented breaking release explicitly approves the change.
- **Browser interface:** Treat `js/gl.js`, its exported `load()` entry point, and the imports/exports defined by `src/native/wasm.rs` and `src/native/wasm/webgl.rs` as a single version-coupled unit. Build and deploy JS and WASM from the same commit. A matching filename or successful compilation is not sufficient ABI evidence.
- **Platforms:** Browser/WASM is the qualification target. Windows, Linux, macOS, Android, iOS and other native targets remain **not qualified by this gate** unless each target has its own run and evidence record. The proposed target matrix is in the [platform support policy](platform-support-policy.md) (**Proposed**).
- **Upstream:** Review imported fixes independently. Record source revision, license, local diff and test outcome. Do not assume a clean cherry-pick proves compatibility.

## Versioning and change control

Use Semantic Versioning for fork release tags once public release ownership and naming are decided. Before an initial fork-specific tag, do not imply an independently supported release series. A removal, incompatible Rust signature change or incompatible JS/WASM ABI change requires a breaking-version decision and a documented migration path. Additive behavior still requires regression testing. Record changes relative to the last qualified tag and the corresponding upstream Miniquad revision. Do not silently synchronize a new upstream release.

## Candidate evidence record

For each candidate, create a reviewed, committed Markdown record under `docs/release-evidence/` using the fields below. Keep commands and outputs with their source revision; never substitute expected values for observed results.

| Field | Required evidence |
| --- | --- |
| Identity | Candidate tag, exact commit SHA, upstream base SHA, toolchain and lockfile/input revisions |
| Artifact | Exact build commands, artifact paths, SHA-256, raw byte size, gzip and Brotli byte size, and JS/WASM pair revision |
| Quality | Rust format, Clippy, unit/contract tests, JS tests, dependency/security review and CI links, including failures |
| Browser | Actual Chromium, Firefox and WebKit versions; host OS; executable scenarios and results; screenshots/logs where applicable |
| Runtime | Load failure, ABI mismatch, first frame, resize/DPI, keyboard/pointer, WebGL context and render target assertions |
| Performance | Fixture, hardware, repetitions, cold/warm conditions, measured first frame, frame-time p95/p99, memory and transfer metrics, confidence/variation |
| Limits | Untested devices (including physical iOS Safari and Android if applicable), unsupported configurations and open regressions |
| Decision | Named reviewer, date, pass/fail/waiver reason, rollback procedure and release approval reference |

Compute byte counts from **the exact shipped JS and WASM files**, not an unrelated local build. Example commands (run after producing those files):

```sh
sha256sum path/to/app.wasm path/to/gl.js
wc -c path/to/app.wasm path/to/gl.js
gzip -n -9 -c path/to/app.wasm | wc -c
gzip -n -9 -c path/to/gl.js | wc -c
brotli -q 11 -c path/to/app.wasm | wc -c
brotli -q 11 -c path/to/gl.js | wc -c
```

Record if `brotli` or a target browser is unavailable; do not report a synthetic zero. Include the compressing tool versions. These commands measure artifact bytes, **not** network transfer timing or runtime performance.

## Release gate

A browser-qualified release requires **all** of the following:

1. Required CI jobs pass for the **exact candidate commit**. A skipped, pending, or absent job is not a pass.
2. Compiled JS/WASM ABI contract checks pass and the JS bridge matches the candidate WASM revision.
3. Browser acceptance tests execute in real Chromium, Firefox and WebKit and pass the agreed required scenarios. An engine-emulation result does not qualify a physical iOS/Android device.
4. Known applicable security findings are resolved or have a documented, approved risk decision. A previous closed tracking issue is not proof that new dependencies are safe.
5. Performance budgets are calibrated against baseline measurements. A provisional hypothesis is **not** an enforced SLO until a reviewed gate defines it.
6. A reviewer verifies artifact hashes, CHANGELOG/compatibility impact, retained reports and the rollback plan.

**No release** if any mandatory check fails, a runtime assertion has no evidence, or required review is absent. A waiver must name the check, scope, residual risk, owner and expiry, and cannot be described as a pass.

## Candidate and rollback exercise

1. Tag a candidate from an immutable reviewed SHA; build artifacts reproducibly and record hashes.
2. Serve the exact candidate JS/WASM pair over HTTP and execute browser tests on that candidate.
3. Publish only after the release gate decision has been recorded.
4. Rehearse rollback in a test deployment: redeploy the previous qualified JS/WASM pair **together**, verify the hashes and first-frame behavior, and record the result.
5. If an incompatible public API or persistent state format changed, document why rollback is safe or block release until a safe migration path exists.

## Current qualification status

**Not qualified.** This document is a policy and an evidence template; it contains no benchmark, browser run, CI result, release candidate or rollback exercise. Issue #19 stays open until the acceptance evidence is available.
