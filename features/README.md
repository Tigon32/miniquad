# Executable browser-first behavior scenarios

* Review date: 2026-11-10
* Source baseline: `874bd443f05ed5b0562ad6d2cfbafdcd05f084b8`
* Tracking issue: [#25](https://github.com/Tigon32/miniquad/issues/25)
* ABI contract: [ABI v3](../docs/abi-v3-contract.md)
* Terminology: [Miniquad glossary](../docs/glossary.md)
* Status: **Executable catalogue; not an independent security certification**

The machine-readable [scenario catalogue](scenarios.json) records
`Given`, `When`, and `Then` fields for each test. Scenario IDs use
`LOAD-`, `INPUT-`, `TRANSFER-`, `GPU-`, and `RESIL-` with a three-digit
suffix. Each scenario points to a literal runnable `test()` in either
`tests/browser/` or a Node bridge test.

The required integration workflow executes
`node scripts/check-scenarios.mjs`. This checks that every referenced test
still exists and is not `test.skip` or `test.todo`. The same workflow
executes the Node tests and Chromium browser suite. The separate
three-engine workflow runs the browser scenarios in Chromium, Firefox and
WebKit. A passing catalogue check **only** validates linkage; actual runtime
evidence comes from the test jobs.

## Recorded failing and corrected cases

| Family | Failure evidence | Corrected evidence | Interpretation |
| --- | --- | --- | --- |
| Input | [Run 42877182895](https://github.com/Tigon32/miniquad/actions/runs/42877182895) failed when WebKit did not return the right-button `mouseup` | [Run 42877840392](https://github.com/Tigon32/miniquad/actions/runs/42877840392) passed 17/17 tests in all three engines after the canvas context-menu fix | Observed cross-engine runtime failure and correction |
| Clipboard | [Run 42874677361](https://github.com/Tigon32/miniquad/actions/runs/42874677361) failed a Firefox clipboard transfer | [Run 42876333412](https://github.com/Tigon32/miniquad/actions/runs/42876333412) passed after standard MIME and test-fixture correction | Some failure came from synthetic event differences; not an OS-clipboard permission qualification |
| GPU/offscreen | [Run 42874677361](https://github.com/Tigon32/miniquad/actions/runs/42874677361) failed WebKit WebGL1 depth attachment with incomplete framebuffer | [Run 42876333412](https://github.com/Tigon32/miniquad/actions/runs/42876333412) passed with explicit WebGL2 offscreen fixture | Supports the documented WebGL2 path, not WebGL1 depth textures |

Other loader, transfer ownership and file-drop cases have negative-input
assertions that pass on the current source. A historical failing CI run for
every one of those families is **not established**. Do not fabricate a
failing-before-fix result or infer that the old module was tested on every
browser.

## Runtime and CI limits

The ordinary PR CI tests Chromium with a built release WASM and locked npm
tools. The three-engine lane downloads the locked Playwright engine revisions
and tests Chromium, Firefox and WebKit (headful under a virtual display for
Firefox/WebKit). Playwright WebKit is not physical iOS Safari.

A scenario that is skipped, pending, or missing must not count as passed.
The catalogue does not select or disable tests. Every test assertion still
runs in its normal CI lane. CI traces are uploaded on browser failure.

The project keeps expensive compatibility campaigns separate from its
focused required PR lane. Full fuzz/property coverage belongs in
[issue #21](https://github.com/Tigon32/miniquad/issues/21).

A future behavior change should update the scenario JSON, the referenced
runtime test and exact-head CI evidence together. Record the source SHA,
browser/tool versions, expected and observed events, and any intermittent
failure in the tracking issue.
