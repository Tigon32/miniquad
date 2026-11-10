# Miniquad: initial source audit

* Date: 2026-11-10
* Source reviewed: [`fa94814c9f488fe5c8b06afae3c88ca80288a4c9`](https://github.com/Tigon32/miniquad/tree/fa94814c9f488fe5c8b06afae3c88ca80288a4c9)
* Review state: **Partial source audit**
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

This is a record of one source audit.
It is not proof that Miniquad has no other bugs.
The source revision in this report is older than some merged fixes.
Use [the current gap analysis](../gap-analysis-2026-11.md) for the work order.

## What we checked

We read selected sections of these files:

* `js/gl.js`
* `src/native/wasm.rs`
* `src/native/wasm/webgl.rs`
* `src/fs.rs`
* `src/graphics.rs`
* `src/graphics/gl.rs`
* Selected native platform files
* CI workflows and package files

We also reviewed existing GitHub issues.
We used the [project skills](../../AGENTS.md) to guide the review.

## What we ran

We ran an isolated Node.js test of the `stringToUTF8` algorithm.
The test ran with Node.js **v22.16.0** in a hosted sandbox.
We checked the test script syntax with `node --check`.

We did **not** run compiled Miniquad WASM, a real browser, or GPU rendering in this source audit.
We did not run native Windows, macOS, iOS, or Android tests.
We did not run a complete Rust test suite, a fuzz campaign, or a performance benchmark during this audit.

GitHub Actions ran separate checks for [PR #23](https://github.com/Tigon32/miniquad/pull/23).
Those checks are not proof of browser behavior.

## Findings and issue groups

| ID | Finding | Source evidence | Issue |
| --- | --- | --- | --- |
| ABI-01 | JS used the number of UTF-16 code units to allocate a UTF-8 filename. This can cut off characters. Rust then made a `String` from the input bytes. | [JS drop code](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1375-L1387), [encoder](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L162-L197), [Rust receiver](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/wasm.rs#L356-L367) | [#8](https://github.com/Tigon32/miniquad/issues/8) |
| ABI-02 | The loader can make a no-op function for a missing WASM import. The application can start without a required function. | [JS loader](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1538-L1551) | [#8](https://github.com/Tigon32/miniquad/issues/8) |
| WEBGL-01 | In the WebGL1 path, the code can use a null context before the final null check. | [WebGL setup](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L27-L95) | [#13](https://github.com/Tigon32/miniquad/issues/13) |
| GL-02 | The native GL version code uses a pointer without a null check. We have not proved that a null return can occur on a supported path. | [GL version](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/graphics/gl.rs#L821-L827) | [#13](https://github.com/Tigon32/miniquad/issues/13) |
| INPUT-01/02 | The browser file-drop code copies each file into memory. The reviewed code has no explicit input-size limit. Callback order and failure cleanup need tests. | [JS drop code](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1370-L1391), [Rust receiver](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/wasm.rs#L344-L367) | [#16](https://github.com/Tigon32/miniquad/issues/16) |
| TIMER-01 | The GPU timer API has incomplete functions. One function panics. Another always returns zero. | [ElapsedQuery](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/graphics.rs#L881-L965) | [#12](https://github.com/Tigon32/miniquad/issues/12) |
| LOADER-01/02 | The loader does not stop after every version error. Its two loading paths have different error handling. | [JS loader](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/js/gl.js#L1554-L1607) | [#15](https://github.com/Tigon32/miniquad/issues/15) |
| WIN-01/02/03 | The Windows drop code uses a fixed-length path, has an unchecked file read, and does not call `DragFinish` in the reviewed file. | [Windows input](https://github.com/Tigon32/miniquad/blob/fa94814c9f488fe5c8b06afae3c88ca80288a4c9/src/native/windows.rs#L741-L760) | [#24](https://github.com/Tigon32/miniquad/issues/24) |
| BUILD-01 | The npm tools had no transitive lockfile at the audit revision. | [PR #23](https://github.com/Tigon32/miniquad/pull/23) | [#9](https://github.com/Tigon32/miniquad/issues/9) |

## UTF-8 test results

The test used the same control flow and byte writes as `js/gl.js` lines 162–198.
It allocated `Uint8Array(name.length)`.
It then used `TextDecoder` to read the bytes.
The test did not execute compiled WASM.

| Filename | JS code units | UTF-8 bytes needed | Bytes written | Output |
| --- | ---: | ---: | ---: | --- |
| `foo.txt` | 7 | 7 | 7 | `foo.txt` |
| `é.txt` | 5 | 6 | 5 | `é.tx` |
| `😀.txt` | 6 | 8 | 6 | `😀.t` |
| `é` | 1 | 2 | 0 | `\u0000` |
| `日本語.txt` | 7 | 13 | 6 | `日本\u0000` |

The data shows an encoding-length fault in the isolated JavaScript algorithm.
It does not show the full browser or Rust result.
It does not show that a person can exploit the fault.

[PR #30](https://github.com/Tigon32/miniquad/pull/30) later changed the filename allocation.
The remaining ABI tests are in [#8](https://github.com/Tigon32/miniquad/issues/8) and [#21](https://github.com/Tigon32/miniquad/issues/21).

## Work order

1. Test the JS/WASM interface with compiled WASM. Keep the test for Unicode filenames. See #8 and #21.
2. Test loader errors and missing WebGL contexts in real browsers. See #11, #13, and #15.
3. Set memory and input limits. Test failed and cancelled file drops. See #16.
4. Test the Windows drop handler on Windows. See #24.
5. Use a valid test method for GPU time. Do not use the incomplete timer API for a performance result. See #12.
6. Measure before you change performance-critical code. See #14 and #15.

Do not close an issue from a compiler or syntax check alone.
Give the exact source SHA, test command, result, and limits.
Use a real browser or OS when the claim needs it.
