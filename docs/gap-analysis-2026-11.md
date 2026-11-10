# Miniquad gap analysis and work order

* Date: 2026-11-10
* Reviewed source: [`8238587c89d238e63a834a65895127b689154f86`](https://github.com/Tigon32/miniquad/tree/8238587c89d238e63a834a65895127b689154f86)
* Writing rule: [MADR 0003](adr/0003-use-asd-ste100-for-communication.md)
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

We checked the repository tree, the open issues, the source audit, and selected code.
We did not run new browser tests, native tests, security tests, or benchmarks during this review.
Do not use this report as proof that the software has no other faults.

## Decision

**Do a short analysis. Then fix and test the important faults.**
Use the existing issues when they cover the same fault.
Do not open a second issue for the same root cause.
Do not close an issue without test evidence.

## Important gaps

| Priority | Gap | Issue and required work |
| --- | --- | --- |
| P0 | CI does not prove browser behavior. The Rust library test has also run with zero unit tests. | [#11](https://github.com/Tigon32/miniquad/issues/11), [#9](https://github.com/Tigon32/miniquad/issues/9), [#25](https://github.com/Tigon32/miniquad/issues/25): Add real browser tests and a small set of behavior tests. |
| P0 | The JS/WASM interface needs tests of exact bytes and memory ownership. | [#8](https://github.com/Tigon32/miniquad/issues/8), [#21](https://github.com/Tigon32/miniquad/issues/21): Verify UTF-8, pointers, lengths, and error states. [PR #30](https://github.com/Tigon32/miniquad/pull/30) fixed one filename fault. |
| P0 | The loader can install a function that does nothing when a required import is missing. It can also continue after a version mismatch. | #8, [#15](https://github.com/Tigon32/miniquad/issues/15): Add failure tests. Make an invalid interface stop startup. |
| P0 | WebGL context and GPU resource failures need real-browser tests. | [#13](https://github.com/Tigon32/miniquad/issues/13): Test WebGL1, WebGL2, context loss, and resource lifetime. |
| P0 | File input has no explicit memory limit in the reviewed path. The Windows file-drop handler also has resource and error risks. | [#16](https://github.com/Tigon32/miniquad/issues/16), [#24](https://github.com/Tigon32/miniquad/issues/24): Define resource limits and test failure paths. |
| P1 | Rust tests and lints need a reviewed baseline. Some graphics functions can panic. | [#10](https://github.com/Tigon32/miniquad/issues/10), #13: Add small tests and approved CI checks. |
| P1 | The GPU timer API has incomplete functions. It cannot supply valid GPU timing measurements now. | [#12](https://github.com/Tigon32/miniquad/issues/12): Set a test method. Measure actual size, time, and memory before optimization. |
| P1 | Release and CI rules need complete verification. | [#17](https://github.com/Tigon32/miniquad/issues/17), [#19](https://github.com/Tigon32/miniquad/issues/19), [#20](https://github.com/Tigon32/miniquad/issues/20): Check required tests, author rules, and release evidence. |
| P2 | Optional voxel support and server-side execution need an architecture test. | [#29](https://github.com/Tigon32/miniquad/issues/29): Test a small WASM-only scene first. Add server execution only when a measured need exists. |

## Possible code improvements

These are possible changes. They are not completed features.

1. **Use one string transfer contract.** Some JS paths use `TextEncoder`. Other paths use `stringToUTF8`. Use the same byte and ownership rules. Test both sides before you change an interface. See #8 and #21.
2. **Give the loader one defined failure state.** The two paths in `load()` do similar work. Add negative tests before you combine them. See #15.
3. **Check GPU capabilities before use.** Do not return a success result from an incomplete function. See #13 and #12.
4. **Set limits for external data.** Check file size, callback order, memory use, and cleanup. See #16 and #24.
5. **Keep game logic outside Miniquad.** The voxel project can share pure Rust logic between WASM and native code. Keep the Miniquad library focused on graphics and input. See #29.

## Work order

| Step | Required result | State |
| --- | --- | --- |
| A — UTF-8 filename | Test exact UTF-8 bytes in the JS bridge. Then test the compiled WASM interface in a browser. | [PR #30](https://github.com/Tigon32/miniquad/pull/30) merged. Full browser ABI tests are still open. |
| B — Loader errors | Test a missing import, wrong version, and unavailable WebGL context. | Open: #8 and #15 |
| C — Browser rendering | Test the first frame, input, resize, WebGL1, WebGL2, and shutdown in real browsers. | Open: #11 and #25 |
| D — Input limits | Test small, large, invalid, and cancelled inputs. | Open: #16 and #24 |
| E — Measurements | Use equal workloads. Record code size, time, and memory with units. | Open: #12 |
| F — Voxels | Render a small 3D voxel world with a 2D sprite and HUD. | Open: #29 |

## Close an issue

1. Reproduce the fault or state why a test is blocked.
2. Add a regression test when possible.
3. Verify the required checks on the exact PR revision.
4. Run browser or native tests when the claim needs them.
5. Record the result and the tests that did not run.
6. Confirm the merge to `master`.
7. Close the issue only when all acceptance conditions pass.

See [the roadmap](https://github.com/Tigon32/miniquad/issues/22) and [MADR 0002](adr/0002-risk-based-verification-and-selective-tdd.md).
