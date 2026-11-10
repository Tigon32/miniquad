---
name: miniquad-wasm-abi
description: Test the Rust and JavaScript WASM interface, exact byte lengths, memory ownership, and error states.
---

# Check the WASM interface

Use this skill for changes to `js/gl.js`, `src/native/wasm.rs`, `src/native/wasm/webgl.rs`, or `src/fs.rs`.
Read [issue #8](https://github.com/Tigon32/miniquad/issues/8) and [AGENTS.md](../../../AGENTS.md) first.

## Procedure

1. Build the WASM module. Record the source SHA and build flags.
2. List the WASM imports and exports. Compare them with the functions in `js/gl.js`.
3. Record each parameter type. Include the units, allowed length, and direction of transfer.
4. For a JavaScript string, use its encoded UTF-8 **byte length**. Do not use the number of UTF-16 code units.
5. Show which side allocates the memory. Show which side must free it.
6. Check all pointer and length values before you use them.
7. Confirm that Rust receives valid UTF-8 where it builds a `String`.
8. Test an empty string, `é`, emoji, a long string, and invalid input.
9. Check the order of loader, WASM startup, browser events, and file callbacks.
10. If a required import is missing, make the failure visible. Do not install a silent function in its place.
11. If the ABI version is incorrect, do not start the game loop.
12. Use a real browser and compiled WASM for runtime memory claims. A JavaScript mock alone is not sufficient.

## Pass conditions

The old fault must fail in a baseline test.
The new code must pass the same test.
The JS/WASM contract must stay correct.
Record the tests, source SHA, and browser versions.
If a check did not run, state that it did not run.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
