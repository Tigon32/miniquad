# Miniquad initial evidence-led reliability audit

* **Date:** 2026-11-10
* **Audited baseline:** [`Tigon32/miniquad@fa94814c9f488fe5c8b06afae3c88ca80288a4c9`](https://github.com/Tigon32/miniquad/tree/fa94814c9f488fe5c8b06afae3c88ca80288a4c9) (before npm lockfile PR #23)
* **Review method:** Repository-local [source audit](../../.github/skills/miniquad-source-audit/SKILL.md), [WASM ABI](../../.github/skills/miniquad-wasm-abi/SKILL.md), [browser verification](../../.github/skills/miniquad-browser-repro/SKILL.md), [native FFI](../../.github/skills/miniquad-native-safety/SKILL.md), [security gates](../../.github/skills/miniquad-security-gates/SKILL.md), [performance proof](../../.github/skills/miniquad-performance-proof/SKILL.md), and [verified delivery](../../.github/skills/miniquad-verified-delivery/SKILL.md).
* **Reviewed:** `js/gl.js`, `src/native/wasm.rs`, `src/native/wasm/webgl.rs`, `src/fs.rs`, `src/graphics.rs`, `src/graphics/gl.rs`, representative native backends, workflow/package manifests, and existing keeper issues. Static source review is **selective**, not whole-repository formal verification.
* **Executed on a hosted server-side sandbox:** Node v22.16.0 isolated test of the inspected `stringToUTF8` algorithm; `node --check` of that test. A separate hosted GitHub Actions run for PR #23 verified `npm ci` and ESLint. **Not executed:** full Rust builds as part of this audit, actual compiled Miniquad WebAssembly, browser/WebGL rendering, Windows/macOS/iOS/Android runtime tests, fuzz campaigns or calibrated performance benchmarks. Relevant GitHub CI is separately recorded per PR.

## Grouped findings

| Cluster | Evidence at audited SHA | Status and impact | Keeper |
| --- | --- | --- | --- |
| **ABI-01**: dropped filename allocation uses UTF-16 length, not UTF-8 byte length | [`js/gl.js:1375-1387`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1375-L1387); [encoder at lines 162-197](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L162-L197); [Rust reconstruction](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/wasm.rs#L356-L367) | **Source-observed; isolated algorithm reproduced**. Non-ASCII names can be truncated, leaving invalid bytes/NUL. Browser/WASM impact remains to be tested. | [#8](https://github.com/Tigon32/miniquad/issues/8) |
| **ABI-02**: required missing JS imports become no-op stubs | [`js/gl.js:1538-1551`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1538-L1551) | **Source-observed**: incompatible WASM may link without functionality. Actual version-skew test not run. | [#8](https://github.com/Tigon32/miniquad/issues/8) |
| **WEBGL-01**: unavailable WebGL1 context dereferenced before null check; WebGL2 continues after alert | [`js/gl.js:27-95`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L27-L95) | **Source-observed** likely initialization failure; real-browser repro needed. No context-loss lifecycle handling was found during the targeted bridge scan. | [#13](https://github.com/Tigon32/miniquad/issues/13) |
| **GL-02**: null-sensitive FFI version string | [`src/graphics/gl.rs:821-827`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/graphics/gl.rs#L821-L827) | **Conditional unsafe precondition risk** if `glGetString` returns null; actual reachability not established. | [#13](https://github.com/Tigon32/miniquad/issues/13) |
| **INPUT-01/02**: unbounded dropped-file copies, incomplete async failure and overlapping drop state | [`js/gl.js:1370-1391`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1370-L1391); [Rust drop state](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/wasm.rs#L344-L367) | **Source-observed** potential memory exhaustion and incomplete/reordered events; browser tests missing. | [#16](https://github.com/Tigon32/miniquad/issues/16) |
| **TIMER-01**: public GPU timer APIs are placeholders | [`src/graphics.rs:881-965`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/graphics.rs#L881-L965) | **Source-confirmed**: `is_supported()` panics, `get_result()` returns zero, `is_available()` returns false; unsuitable as timing evidence. | [#12](https://github.com/Tigon32/miniquad/issues/12) |
| **LOADER-01/02**: missing canvas and version mismatch; loader does not expose async completion | [`js/gl.js:13,98`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L13-L98); [`load`:1554-1607](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1554-L1607) | **Source-observed** error-handling defects/risks; browser failure fixtures pending. | [#15](https://github.com/Tigon32/miniquad/issues/15) |
| **WIN-01/02/03**: Windows drop handler uses fixed-size path buffer, unchecked file read and does not call `DragFinish` | [`src/native/windows.rs:741-760`](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/windows.rs#L741-L760) | **Source-observed** Windows availability/resource risks; no Windows runtime test. | [#24](https://github.com/Tigon32/miniquad/issues/24) |
| **BUILD-01**: npm lint dependencies not transitively locked | Historical CI on baseline | **Remediated** by [PR #23](https://github.com/Tigon32/miniquad/pull/23), with `npm ci` and green required PR CI; JS behavior testing still outstanding. | [#9](https://github.com/Tigon32/miniquad/issues/9) |

## Isolated server-side Unicode reproduction

The script uses the same control flow and byte writes as `js/gl.js` lines 162-198 at the baseline SHA. It creates a `Uint8Array(name.length)`, matching `js/gl.js:1376-1380`, and decodes the bytes with `TextDecoder`. The test ran under Node.js **v22.16.0** on the hosted execution container, **not** in a browser or compiled WASM.

| Filename | JS code units | Actual UTF-8 bytes | Bytes written | Decoded buffer |
| --- | ---: | ---: | ---: | --- |
| `foo.txt` | 7 | 7 | 7 | `foo.txt` |
| `é.txt` | 5 | 6 | 5 | `é.tx` |
| `😀.txt` | 6 | 8 | 6 | `😀.t` |
| `é` | 1 | 2 | 0 | `\\u0000` |
| `日本語.txt` | 7 | 13 | 6 | `日本\\u0000` |

Actual Windows, browser and Rust behavior may differ: the results validate the **isolated encoding mismatch**, not exploitability or full-product outcomes. For the next phase, add a compiled WASM fixture and baseline-failing browser regression.

## Interpretation and triage

- **P0, before browser-readiness claim:** ABI filename sizing and missing imports (#8); denied WebGL context and invalid context handling (#13). Build real-browser acceptance (#11) and adversarial tests (#21) before fixing contracts blindly.
- **P1, resilience:** bounded, failure-aware drops (#16); loader errors (#15); native Windows `WM_DROPFILES` (#24) with a real Windows verification lane.
- **P1, measurement integrity:** reject placeholder `ElapsedQuery` outputs and calibrate size, startup, CPU/GPU and heap metrics (#12) before tuning (#14/#15).
- **Already improved:** reproducible JS tooling is merged via #23, but existing ESLint correctness checks do not prove behavior.
- **Unknown:** full unsafe Rust audit, browser interop, native thread safety and memory safety, dependency advisory state, real GPU context-loss recovery, semantic parity across all platforms and quantified speedups are **not qualified**. Zero known CVEs or zero bugs is **not** asserted.

## Next tests and delivery evidence

A proposed fix must demonstrate the pre-fix failure, identify the first wrong decision, add a regression test that fails on baseline, and show post-fix behavior under an exact commit/browser/toolchain. Use small targeted PRs, pass enforced GitHub checks, and preserve unresolved platform limitations. A code-generation skill is only guidance; it cannot replace execution and review. The audit findings live in grouped existing issues #8, #12, #13, #15, #16 and #9 plus new Windows keeper #24.
