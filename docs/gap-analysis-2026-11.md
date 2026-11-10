# Miniquad: bounded gap analysis and execution queue

* Date: 2026-11-10
* Audited base: [`8238587c89d238e63a834a65895127b689154f86`](https://github.com/Tigon32/miniquad/tree/8238587c89d238e63a834a65895127b689154f86)
* Method: checked the complete repository tree, existing open issue titles/bodies, `AGENTS.md`, [initial source audit](audits/2026-11-10-initial-source-audit.md), relevant JS/WASM/GL/file-system and CI source paths. No new browser/native execution, security scan or benchmark was performed for *this* gap review.
* Disposition: **execute existing outcomes before expanding the backlog**. A gap analysis is not a guarantee that all defects were discovered. New issues require evidence of an outcome not covered by existing keepers.

## Decision

**Short analysis, long execution.** Preserve the existing issue graph and focus on achieving executable validation before adding rendering features or speculative performance refactors. Consolidate overlapping scopes by dependency, not by hiding findings or closing issues without proof.

| Rank | Gap / evidence | Keeper and near-term acceptance |
| --- | --- | --- |
| 0 — first | **Behavior is not validated by CI**: `cargo test --lib` has previously executed **zero tests**; JS syntax, ESLint and WASM compilation do not run WebGL in a browser | [#11](https://github.com/Tigon32/miniquad/issues/11), [#9](https://github.com/Tigon32/miniquad/issues/9), [#25](https://github.com/Tigon32/miniquad/issues/25). Establish deterministic JS/WASM boundary assertions and browser smoke; require real executed counts and failure cases |
| 0 — first | **UTF-8/ownership boundary**: JS drop filename allocation uses UTF-16 length while Rust reconstructs an owned UTF-8 `String`; the pre-fix UTF-8 mismatch is shown in [the audit](audits/2026-11-10-initial-source-audit.md) | [#8](https://github.com/Tigon32/miniquad/issues/8), [#21](https://github.com/Tigon32/miniquad/issues/21). First vertical slice [PR #30](https://github.com/Tigon32/miniquad/pull/30): exact UTF-8 byte counts + Node real-bridge fixture; verify CI, then independently validate compiled WASM/browser |
| 0 — first | **Silent fail-open compatibility**: [loader imports](../js/gl.js) fabricate no-op functions and only log version mismatches before `main()` | #8, [#15](https://github.com/Tigon32/miniquad/issues/15). Define ABI contract; negative tests for absent imports/incorrect versions, then explicit loader failure behavior |
| 0 — first | **Context/capability lifecycle**: null WebGL context path can be used before guard; GPU objects and render-target/context loss need real target checks | [#13](https://github.com/Tigon32/miniquad/issues/13), #11. Test WebGL1/2 create/bind/delete/restore and missing extensions on actual engines |
| 0 — first | **Unsafe ownership and unbounded external input**: dropped-file bytes are materialized across JS/WASM without an explicit ceiling; Windows `WM_DROPFILES` has unchecked read, fixed `MAX_PATH` and missing `DragFinish` | #8, [#16](https://github.com/Tigon32/miniquad/issues/16), [#24](https://github.com/Tigon32/miniquad/issues/24), #21. Agree resource bounds; test 0/large/error/late callbacks; verify native Windows independently |
| 1 | **Rust regression contract and tool gates**: `src/graphics.rs`, `src/graphics/gl.rs` contain incomplete capability APIs and scattered panics; no approved fmt/Clippy baseline | [#10](https://github.com/Tigon32/miniquad/issues/10), #13. Introduce tests and checked lints incrementally rather than suppressing legacy findings globally |
| 1 | **Unqualified measurement**: public `ElapsedQuery` support panics, availability returns false and result returns zero, so it cannot be the GPU measurement source | [#12](https://github.com/Tigon32/miniquad/issues/12), #13, [#14](https://github.com/Tigon32/miniquad/issues/14). Baseline compressed WASM+JS bytes, startup, CPU frame, heap/GPU allocations with real instrumented workloads before tuning |
| 1 | **Delivery/security release gate**: green compilation is not browser-qualified; dependency and workflow governance must remain reproducible and write-scoped | [#16](https://github.com/Tigon32/miniquad/issues/16), [#17](https://github.com/Tigon32/miniquad/issues/17), [#19](https://github.com/Tigon32/miniquad/issues/19), #20. Require validated checks on exact PR head, branch rules and explicit unknowns |
| 2 — later | **Feature architecture choices**: optional voxel renderer, 2D/3D composition and WASM-only versus native authoritative server simulation | [#29](https://github.com/Tigon32/miniquad/issues/29). First verify the small WASM-only render slice. Only enable SSE when a product workload makes it worthwhile |

## Missed opportunities / refactoring candidates (not yet new features)

1. **One byte-exact encoding and ownership contract.** Character names/clipboard use separate `TextEncoder` and manual `stringToUTF8` paths; consolidate only after paired ABI fixtures prove semantics. Risk: changing a raw pointer protocol without a Rust-side test. Covered by #8, #9 and #21.
2. **One loader state machine with explicit error outcomes.** Two branches of `load()` repeat instantiation, version mismatch and setup while resolving/handling errors differently. Refactor only after negative tests, and test MIME/streaming compatibility. Covered by #15 and #8.
3. **WebGL lifecycle and GPU capability feature gates.** Avoid fake success/placeholder timer APIs; specify supported versus unsupported operations by backend. Covered by #13 and #12.
4. **Bounded resource and callback ownership.** Fix failed/cancelled/duplicate input and async completion semantics before adding more concurrency, sockets or chunk streaming. Covered by #16/#21/#24.
5. **Separation of simulation and rendering.** Keep voxel data and authoritative server state outside the Miniquad platform abstraction; share pure Rust rules only when real WASM/native target behavior is equivalent. Covered by #29.

## Thin-slice execution policy

| Slice | Prove before claiming done | Current status |
| --- | --- | --- |
| A: Unicode filenames | Test pre-fix source failure on non-ASCII/emoji and the exact bridge after fix; run required CI and eventually browser/WASM test | [PR #30](https://github.com/Tigon32/miniquad/pull/30) submitted; **CI/result to be verified** |
| B: ABI loader failures | Negative tests for missing import, version mismatch and unavailable WebGL; no `main()` on invalid contract | Pending #8/#15 |
| C: real render acceptance | Headless Chromium, Firefox, WebKit with pinned sample; first frame, input, resize, WebGL1/2 and teardown | Pending #11/#25 |
| D: bounded inputs | Unicode/cancellation/size caps on clipboard/drop and native Windows file handling | Pending #16/#24 |
| E: measurement | Same compiled demo, paired baselines, compressed transfer and memory/frame counters | Pending #12 |
| F: optional voxel slice | Mixed 2D sprite + 3D voxel world in offline WASM; compare authoritative native simulation only with actual workload | Pending #29 |

## Closure discipline

For every keeper: reproduce or explicitly report blocked, add a failing-before-fix regression, verify *the precise PR head* with required checks, record tested browsers/devices and remaining risks, confirm merge to `master`, and only then close the fully accepted issue. **A partial PR does not close an issue.** A merged source fix without a real browser check is not a browser release qualification.

No unmeasured speedups, zero-bug claims, unexplained issue closures, full-game-engine dependency import, or automatic server requirement are authorized by this analysis. Maintain the backlog within [roadmap #22](https://github.com/Tigon32/miniquad/issues/22).
