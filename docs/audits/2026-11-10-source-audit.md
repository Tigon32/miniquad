# Miniquad source audit: browser-first risk clusters

* Date: 2026-11-10
* Audited source: [Tigon32/miniquad @ 90818fade7e54469ff598efd8c409537383c2770](https://github.com/Tigon32/miniquad/tree/90818fade7e54469ff598efd8c409537383c2770)
* Method: Read-only source tracing guided by [the six project-local skills](../../AGENTS.md), especially `miniquad-source-audit`, `miniquad-wasm-abi`, `miniquad-browser-repro`, `miniquad-native-safety`, `miniquad-performance-proof` and `miniquad-verified-delivery`.
* Status: **bounded source audit, not full code verification**. Findings are source-observed unless explicitly stated; no runtime reproduction, fuzzing, GPU timing, security exploitation, or end-to-end browser execution was performed in this audit. A compiler check is not a behavioral test.

## Coverage and exclusions

| Surface | Inspected | Executed in this audit? | Limits |
| --- | --- | --- | --- |
| JS browser bridge and loader | `js/gl.js` (file and relevant lifecycle/UTF-8 sections) | No | Real browser, DOM event, CSP, MIME and WebGL failure paths untested |
| WASM Rust callbacks and memory | `src/native/wasm.rs`, `src/fs.rs`, `src/native/wasm/webgl.rs` | No | ABI memory ownership and actual callbacks not dynamically verified |
| Rendering and resource lifecycle | `src/graphics.rs`, `src/graphics/gl.rs` | No | Other rendering backends not exhaustively audited |
| Native platform edge | Windows drop handler, Linux/X11/Wayland clipboard, Android/JNI; selected macOS/other platform paths identified in tree | No | These are spot checks, **not** native OS audits |
| CI/dependencies | `Cargo.toml`, `package.json`, GitHub workflow sources and PR #23 | PR #23 CI passed separately | No security advisories/license audit; no local Rust, Clippy or browser run |
| Benchmarks and size | Code paths and planned SLI criteria | No | No performance baseline, memory benchmark or payload measurement |

### Findings (group by root cause / shared acceptance harness)

| ID | Evidence status and impact | Evidence (immutable source) | Keeper |
| --- | --- | --- | --- |
| MQ-A1 | **High, source-observed UTF-8 filename corruption risk.** JS allocates dropped-file name bytes using UTF-16 `name.length` while writing UTF-8; Rust reconstructs using `String::from_raw_parts`, so correct allocation/initialization and valid UTF-8 invariants depend on mismatched lengths. | [JS drop](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L1375-L1388), [encoder](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L162-L197), [Rust callback](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/src/native/wasm.rs#L355-L367) | [#8](https://github.com/Tigon32/miniquad/issues/8), #16, #21, BDD #25 |
| MQ-A2 | **High, source-observed failure masking.** JS fabricates missing WASM import stubs and continues to `main()` after `crate_version` mismatch; startup failure path is not fail-closed. | [loader](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L1538-L1607) | [#8](https://github.com/Tigon32/miniquad/issues/8), [#15](https://github.com/Tigon32/miniquad/issues/15) |
| MQ-A3 | **Medium/high risk, source-observed capability/lifecycle gaps.** WebGL1 extension path dereferences `gl` before the final null-context alert; native GL version decoding calls `CStr::from_ptr` without null validation. Actual trigger/platform state unverified. | [WebGL init](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L27-L96), [GL version](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/src/graphics/gl.rs#L821-L827) | [#13](https://github.com/Tigon32/miniquad/issues/13), #15 |
| MQ-A4 | **Confirmed incomplete API, source-observed.** Public `ElapsedQuery` support method panics, result always zero and availability always false; cannot use it as a real GPU benchmark. | [ElapsedQuery](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/src/graphics.rs#L881-L965) | [#13](https://github.com/Tigon32/miniquad/issues/13), [#12](https://github.com/Tigon32/miniquad/issues/12) |
| MQ-A5 | **Medium/high memory pressure risk.** Browser drop eagerly copies all files to JS and WASM buffers, with no size bounds visible in this handler; asynchronous failure and repeated event listener behavior remain hypotheses pending a real runtime. | [Drop handler](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L1370-L1391), [event registration](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/js/gl.js#L1211-L1409) | [#16](https://github.com/Tigon32/miniquad/issues/16), #15, #21 |
| MQ-A6 | **Medium/high, source-observed native Windows lifecycle faults.** Handler appears not to release `HDROP`, uses a fixed `MAX_PATH` buffer, unwraps file reads in a window callback, and eagerly reads every dropped file. Native reproduction required. | [Windows drop handler](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/src/native/windows.rs#L741-L761) | [#27](https://github.com/Tigon32/miniquad/issues/27) |
| MQ-A7 | **Qualification gap, not a discovered runtime defect.** Existing compiler/lint gates do not cover BDD behavior, real browsers or adversarial ABI tests; `cargo test --lib` previously reported **zero tests**. | [CI](https://github.com/Tigon32/miniquad/blob/90818fade7e54469ff598efd8c409537383c2770/.github/workflows/integration-ci.yml), [BDD proposal](https://github.com/Tigon32/miniquad/issues/25) | [#9](https://github.com/Tigon32/miniquad/issues/9), [#10](https://github.com/Tigon32/miniquad/issues/10), [#11](https://github.com/Tigon32/miniquad/issues/11), #21, #25 |

## Recommended resolution order

1. **Boundary correctness before optimization:** reproduce and repair MQ-A1; specify exact Rust/JS memory contract; add BDD and property-test corpus. Require the old input to fail before the fix and pass after.
2. **Visible failure instead of partial success:** test and correct MQ-A2/MQ-A3 using a real browser demo. Explicitly reject unsupported capabilities; preserve legitimate WebGL1 compatibility.
3. **Resilient resource handling:** add size ceilings, explicit failure states and native Win32 drop cleanup/error recovery (MQ-A5/MQ-A6); verify non-ASCII, disappearing file and repeated callback scenarios.
4. **Capability-aware performance testing:** treat MQ-A4 as unimplemented and benchmark CPU/first-frame/transfer without pretending GPU timer data is available. Implement support only where hardware/backend evidence exists.
5. **Qualification gap:** extend CI with tests and real-browser evidence before claiming release readiness, then run paired performance benchmarks with unchanged behavior.

## Verification protocol and audit constraints

* Issues have exact links, expected-vs-actual scenarios and remaining uncertainty. A source search hit is not itself a bug; incomplete/unsafe-looking code must be checked against real platform invariants.
* No full security assessment, advisory scan, native Windows/Android/macOS/iOS run, WebGL1/2 runtime matrix, end-to-end browser harness, fuzz/property suite or calibrated benchmark was completed here.
* Existing [PR #23](https://github.com/Tigon32/miniquad/pull/23) delivered the npm lockfile and `npm ci`; required GitHub Actions passed for that PR. This is **not** evidence that these runtime defects are fixed.
* Preserve the existing [roadmap #22](https://github.com/Tigon32/miniquad/issues/22) and keeper issues; don't manufacture one issue per individual `unwrap` or copy pstack rules verbatim.
* Follow [project-local skill provenance](../skills-provenance.md) for the source and limits of the methodology.

**Result:** seven clustered findings/qualification gaps; one dedicated Windows issue plus updates to existing relevant keeper issues. Severity is triage priority, **not** an established exploitability score or measured probability.
