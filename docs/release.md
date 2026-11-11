# Browser release qualification

**Status:** Proposed policy, not a release approval.  
**Scope:** This fork of Miniquad, initially Rust package `miniquad` 0.4.11.  
**Tracking:** [#19](https://github.com/Tigon32/miniquad/issues/19), [#11](https://github.com/Tigon32/miniquad/issues/11), [#14](https://github.com/Tigon32/miniquad/issues/14), [#22](https://github.com/Tigon32/miniquad/issues/22).

## Compatibility commitments

Until a versioned fork release is approved, do not claim full upstream compatibility.

- **Rust API:** Treat the exported library API in `src/lib.rs`, `src/event.rs`, and `src/graphics.rs` as the compatibility review surface. Review public item signatures and behavioral changes against the previous qualified tag. Preserve compatibility unless a documented breaking release explicitly approves the change.
- **Browser interface:** Treat `js/gl.js`, its exported `load()` entry point, and the imports/exports defined by `src/native/wasm.rs` and `src/native/wasm/webgl.rs` as a single version-coupled unit. Build and deploy JS and WASM from the same commit. A matching filename or successful compilation is not sufficient ABI evidence.
- **Platforms:** Browser/WASM is the qualification target. Windows, Linux, macOS, Android, iOS and other native targets remain **not qualified by this gate** unless each target has its own run and evidence record.
- **Upstream:** Review imported fixes independently. Record source revision, license, local diff and test outcome. Do not assume a clean cherry-pick proves compatibility.

## Versioning and change control

[MADR 0010](adr/0010-browser-release-candidates.md) proposes fork-scoped candidate labels.
The [candidate contract](release-candidate-contract.md) defines the label, package, evidence, and gate.
The first proposed label is `0.5.0-tigon32.1.rc.1`.
Its tag prefix is `tigon32-miniquad-v`.
This is an artifact compatibility label, not a package rename.
The Cargo package remains `miniquad` version `0.4.11`.
MADR 0006 still owns the product identity decision.

The fork uses core browser ABI v3. Its upstream base used browser ABI v2.
Do not pair the upstream bridge with fork WASM.
Before version 1.0, a breaking core API or browser contract change increases the compatibility minor version.
An additive or corrective change increases the patch version under the proposed fork policy.
Record upstream synchronization, deprecation, and migration effects in the change log.
Do not infer compatibility from an upstream version number or a clean merge.

Optional companions and the application-parameter surface keep their own versions.
Bind unversioned embedding assets to their exact source and asset hashes.
An annotated candidate tag must identify reviewed, merged source.
Never replace or delete a candidate tag.
A `.release` tag or public stable release needs separate, explicit human owner approval.

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

Use the [evidence template](release-evidence/TEMPLATE.md).
The machine-readable records in the candidate contract supplement this record.
They do not replace technical review.
Record both the package source and the tool source.
Keep timestamps outside the canonical payload.
Two fresh builds of the same source and toolchain must have identical payload bytes.
Scan the exact payload for private paths and credential patterns before publication.
Retain the complete manifest, lockfile, tool versions, and raw evidence.

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

A browser-qualified candidate requires **all** of the following:

1. Required CI jobs pass for the **exact candidate commit**. A skipped, pending, or absent job is not a pass.
2. Compiled JS/WASM ABI contract checks pass and the JS bridge matches the candidate WASM revision.
3. Browser acceptance tests execute in real Chromium, Firefox and WebKit and pass the agreed required scenarios. An engine-emulation result does not qualify a physical iOS/Android device.
4. Known applicable security findings are resolved or have a documented, approved risk decision. A previous closed tracking issue is not proof that new dependencies are safe.
5. The source-bound reference-profile regression guard passes under the candidate contract. A local rehearsal or provisional device target cannot satisfy this check.
6. A reviewer verifies artifact hashes, CHANGELOG/compatibility impact, retained reports and the rollback plan.

The candidate result is `QUALIFIED-CANDIDATE`, `BLOCKED`, or `FAILED`.
Missing, inconclusive, or waived mandatory evidence blocks qualification.
Record the named reviewer, reviewer kind, exact method, date, and evidence references.
An identified automated agent can review a candidate.
It must record `ownerApproval: false`.
It cannot approve publication on behalf of the human owner.

**No release** if any mandatory check fails, a runtime assertion has no evidence, or required review is absent.
A qualified candidate is not an approved stable release.
Publication needs a separate human owner approval reference.

## Candidate and rollback exercise

1. Tag a candidate from an immutable reviewed SHA; build artifacts reproducibly and record hashes.
2. Serve the exact candidate JS/WASM pair over HTTP and execute browser tests on that candidate.
3. Publish only after the gate decision and separate human owner approval have been recorded.
4. Rehearse rollback in a test deployment: redeploy the previous qualified JS/WASM pair **together**, verify served and browser-received hashes and actual canvas pixels, and record the result.
5. If an incompatible public API or persistent state format changed, document why rollback is safe or block release until a safe migration path exists.

## Current qualification status

Before the first qualified release, the contract permits the bootstrap reference
`f837a98d415262320a8c66ef9f8024d8f2faeab1`.
It has no candidate label and is not a qualified release.
The first rollback exercise proves package integrity and the rollback procedure.
It does not prove a return to a qualified release.
Once a qualified `.release` tag exists, it must replace the bootstrap rollback target.

**Not qualified by this document.**
The proposed contract is not a candidate receipt or an observed test result.
The manual reference-profile job must collect and retain the actual measurements.
Issue #19 stays open until the required candidate and rollback evidence is recorded.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
