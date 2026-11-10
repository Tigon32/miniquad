---
name: miniquad-wasm-abi
description: Verify Rust ↔ JavaScript WebAssembly imports/exports, UTF-8, allocations, pointer ownership and lifecycle contracts in Miniquad.
---

# Verify the Miniquad WASM boundary

Use whenever changing `js/gl.js`, `src/native/wasm.rs`, `src/native/wasm/webgl.rs`, or `src/fs.rs`. Read [glossary](../../../docs/glossary.md) and issue #8 before an ABI change. Preserve the existing `crate_version` contract unless a reviewed ADR and compatibility plan say otherwise.

## Boundary inventory

1. From a **compiled WASM module**, enumerate imports and exports; compare them to the JS `importObject`, loader, and Rust `#[no_mangle]` exports. Record module/name/signature, caller/callee and whether availability is conditional.
2. Record ABI parameter types and units: bytes vs UTF-16 code units, signedness, pointer+length+capacity, UTF-8 validity, null/empty, integer overflow and WASM memory growth. For strings, encode with `TextEncoder` once and pass its actual **byte length**. Never allocate by JS `string.length`.
3. Identify exactly which side allocates, initializes, owns and frees each buffer; check `allocate_vec_u8`, `String::from_raw_parts`, `Vec::from_raw_parts`, clipboard and dropped-file paths. Rust `String::from_raw_parts` requires valid UTF-8 and a valid original allocation with correct capacity. Do not feed it arbitrary, truncated or separately allocated bytes.
4. Trace lifecycle ordering: loader `fetch`/compile/instantiate, `wasm_memory`, `main()`, `init_webgl`, canvas focus, dispatch, resize and file-download callbacks. Missing required imports or incompatible versions must produce a visible failure; never silently fabricate no-op imports.
5. Design tiny deterministic fixtures for ASCII, `é`, surrogate pairs, empty/NUL, lengths 0/1/large, invalid pointer ranges, duplicate callbacks and concurrent file drops. Keep malformed-pointer tests in a safely isolated harness, not a production browser session.
6. Run `node --check js/gl.js`, lint and any focused Node behavior tests. Execute a matching WASM fixture in a real browser when claiming ABI/runtime correctness. Capture browser version and actual events. A compile/link success alone does not prove correctness.

## Acceptance

Old failing input is demonstrated to fail before and pass after, memory ownership is unambiguous, ABI compatibility is preserved or explicitly migrated, and browser behavior is observed. Attach source revision, exact test evidence and unresolved platforms to issue #8/#21; do not silently discard malformed input or misrepresent validation as exploitability proof.
