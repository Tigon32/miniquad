# Miniquad source-grounded architecture

* Baseline source: [master at a21f651a](https://github.com/Tigon32/miniquad/tree/a21f651a36d789e28a4213c3ec00311be9821dc0)
* Review date: 2026-11-10
* Scope: existing browser-first WASM implementation, not a proposed React or server runtime
* Writing status: STE-aligned draft, not a certified ASD-STE100 review

The editable diagrams are [components.mmd](components.mmd) and
[lifecycle.mmd](lifecycle.mmd). The CI diagram checker validates the
limited Mermaid subset used here. A human must verify edges against the source
when the architecture changes.

## Boundaries and responsibilities

| Boundary | Responsibility and code anchor | Ownership and error path |
| --- | --- | --- |
| Application → Miniquad Rust | [src/lib.rs](../../src/lib.rs), [src/event.rs](../../src/event.rs): `start` and `EventHandler` callbacks | The application owns game state. Miniquad calls the handler during the frame and input lifecycle |
| Rust API → WASM platform | [src/native/wasm.rs](../../src/native/wasm.rs): `main`, `frame`, `key_down`, `on_clipboard_paste` | Rust controls event dispatch; invalid transfer ownership is rejected by the registered allocator |
| Loader → WASM | [js/gl.js](../../js/gl.js): `load`, `validate_wasm_imports`, `start_wasm` | The module must match ABI version 3 and required exports. Startup rejects missing imports, version mismatch and failed HTTP fetch |
| WASM → JS | [src/native/wasm/webgl.rs](../../src/native/wasm/webgl.rs) and [js/gl.js](../../js/gl.js) `importObject.env` | Typed memory pointers and lengths are checked by JS helpers; WebGL2-only operations report unsupported capabilities on WebGL1 |
| Browser input → Rust | [js/gl.js](../../js/gl.js) keyboard, pointer, touch, paste and file-drop handlers | Browser focus governs event routing; clipboard and dropped-file bytes use the versioned [transfer contract](../wasm-transfer-abi-v3.md) |
| WebGL and context lifecycle | [js/gl.js](../../js/gl.js) `init_webgl`, `animation`, `webglcontextlost` | GPU resources belong to WebGL. On context loss the animation stops; restoration does not automatically reconstruct state. Reload is required |
| Native target selection | [src/lib.rs](../../src/lib.rs) `start` platform `cfg` blocks | Optional Windows, Apple, Android and Linux runtime paths; see [native qualification](../native-platform-qualification.md) |

## Source and qualification limits

The browser demo is [examples/index.html](../../examples/index.html). The
compiled browser acceptance fixtures and three-engine checks cover the
ordinary frame, input, offscreen rendering and failure paths. They do not
qualify native platforms or actual iOS/Android devices. WebGL1 depth textures
are optional; unavailable depth formats fail explicitly rather than imply
support. The browser-facing loader must match the exact compiled WASM ABI.

Source documentation records intended behavior and its code links. It is
not a proof that every cross-platform implementation satisfies the contract.
