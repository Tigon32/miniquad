# JavaScript–WASM ABI v3 contract

* Date: 2026-11-10
* Source baseline: `a21f651a36d789e28a4213c3ec00311be9821dc0`
* Ownership details: [wasm-transfer-abi-v3.md](wasm-transfer-abi-v3.md)
* Browser confidence: real Playwright Chromium, Firefox and WebKit acceptance is required for each relevant PR
* Scope: the paired `js/gl.js` and `src/native/wasm.rs`; not a stable API for hostile same-origin JavaScript

## Startup and version negotiation

The page loads the checked-in `js/gl.js` alongside its matching WASM module.
`load(path)` fetches, compiles and checks required `importObject` names before
instantiation. `start_wasm` checks `memory`, `main`, `crate_version`,
`allocate_transfer_vec_u8` and `discard_transfer_vec_u8`. It then compares
the exported version to JavaScript's expected version **3**. Missing exports,
invalid imports, HTTP errors and version mismatch reject startup before
`main` is called; the rejection is logged. A successful version check
installs plugins, then enters `main`, which starts event handling and WebGL.

## Rust exports called from JavaScript

The exported functions are `extern "C"`; pointers refer to WASM linear
memory and lengths are **bytes** except where a parameter is an event value.

| Exports | Arguments and units | Lifecycle and transfer |
| --- | --- | --- |
| `crate_version`, `main`, `frame` | No arguments | Version/startup, then animation callbacks |
| `allocate_transfer_vec_u8`, `discard_transfer_vec_u8` | Byte count; pointer | Registration precedes JS writes; discard releases unconsumed memory |
| `allocate_vec_u8` | Byte count | Legacy GL string allocation; **not** a JS-to-Rust ownership transfer API |
| `on_clipboard_paste` | Pointer and exact UTF-8 byte length | Consumes one registered buffer and validates UTF-8 |
| `on_files_dropped_start`, `on_files_dropped_finish` | No arguments | Enclose one serialized browser drop transaction |
| `on_file_dropped` | Path pointer/byte length, bytes pointer/byte length | Consumes both registered buffers, rejects invalid metadata or UTF-8 filenames |
| `mouse_move`, `raw_mouse_move` | Position or movement delta in canvas pixels | Focused pointer callbacks |
| `mouse_down`, `mouse_up`, `mouse_wheel` | Coordinates and mapped button; wheel deltas | Web input dispatch; button map left 0, right 1, middle 2 in Rust |
| `key_down`, `key_up`, `key_press` | Mapped code, modifiers, repeat as applicable | Releases held keys on blur to avoid stuck input |
| `resize` | Drawing-buffer width and height in pixels | Called when CSS size × DPI changes |
| `touch` | Packed touch input | Browser touch events and cancellation |
| `focus` | Focus state | Browser focus transitions |

## Rust imports supplied by JavaScript

Rust's `src/native/wasm/webgl.rs` declares GL imports and
`src/native/wasm.rs` uses browser platform functions. JavaScript's
`importObject.env` provides WebGL commands, clipboard output, event loop,
filesystem/asset loading, time and browser-window operations. The exact
names and `WebAssembly.Module.imports` are verified against a **compiled
WASM fixture** by the executable ABI acceptance test. Import binding
is strict: a required missing entry aborts before module instantiation.
No silent dummy import represents a missing required capability.

The WebGL layer accepts either WebGL1 or WebGL2 only when the requested context
exists. WebGL2-only `readBuffer` and `blitFramebuffer` reject WebGL1 use.
WebGL1 depth textures require the optional extension. On context loss, the
animation stops and a reload is required; restoration does not reconstruct
GPU resources.

## Ownership and error semantics

The browser bridge is trusted code. Untrusted text, filenames and files pass
through bounds checks before calling exported Rust transfer functions.
Registered allocations have exact lengths and a single ownership
transfer. Unknown pointers, mismatched lengths and repeated transfers
are rejected without using caller-provided `Vec::from_raw_parts` metadata.
Failed copies call discard. The current registry has byte and count quotas.
Pointer-address reuse and malicious direct same-origin export calls are
not a supported public plugin API.

The bridge remains versioned as a unit. A breaking export/import or ownership
change increments the ABI version and requires new compiled-WASM runtime
acceptance evidence. Compilation alone is insufficient.

## Executable contract evidence

`tests/browser/abi-contract.spec.mjs` compiles `quad.wasm` from the
actual release fixture, checks expected exports and every declared import
against the checked-in JavaScript bridge, and verifies ABI version 3 after
startup. Existing browser tests cover resize, focus and key release, pointer
buttons, file drops, clipboard, HTTP/version failures and context loss.
Actual iOS Safari and Android Chrome are **not** verified by desktop
Playwright; see [browser mobile qualification](browser-mobile-qualification.md).
