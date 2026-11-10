# JavaScript–WASM transfer ownership contract (ABI v3)

* Date: 2026-11-10
* Related issues: [#8](https://github.com/Tigon32/miniquad/issues/8), [#16](https://github.com/Tigon32/miniquad/issues/16)
* Status: Proposed change, subject to verified CI and owner review

## Version

The paired `js/gl.js` and Rust WASM module require ABI version **3**.
The loader refuses a version mismatch before invoking `main`.
Browser clients must deploy the checked-in loader and matching compiled WASM
together. An ABI v2 executable is not compatible with the new loader.

## Owned allocation protocol

The browser must request transfer memory through
`allocate_transfer_vec_u8(len)` rather than the legacy generic
`allocate_vec_u8` function. The Rust backend keeps a registry of allocated
pointers and their exact logical lengths.

* `allocate_transfer_vec_u8` returns zero on invalid size, quota exhaustion
  or allocation failure. The JavaScript bridge rejects that response.
* The bridge checks the returned pointer before writing encoded UTF-8 or file
  bytes into linear memory. It reacquires memory views after allocations.
* `on_clipboard_paste(ptr,len)` and
  `on_file_dropped(path,path_len,bytes,bytes_len)` consume registered
  allocations exactly once. Missing or mismatched records are rejected without
  reconstructing a Rust vector from untrusted pointer metadata.
* If a JavaScript copy or callback fails, the bridge calls
  `discard_transfer_vec_u8(ptr)` to release outstanding allocations.
  Discarding an already consumed pointer is a no-op.
* Rust caps one registered allocation at 64 MiB, the total registered data
  at 64 MiB plus 4096 bytes, and the outstanding count at 256. The browser
  separately enforces its existing 1 MiB clipboard and 32 MiB per-file limits.

The generic `allocate_vec_u8` remains for the existing GL string import
contract. Do not use it for ownership transfer to clipboard/file callbacks.

## Scope and limitations

This registry prevents forged pointer dereference and duplicate raw-parts
reconstruction within the registered transfer protocol. It does not make
untrusted same-origin JavaScript a supported plugin or public Rust export API.
A stale pointer reused by the allocator may have the same address as a later
allocation; JavaScript still must not intentionally replay prior transfers.
The browser loader, wasm module, and JavaScript environment must be trusted and
version-matched.

The browser acceptance fixture covers unknown pointers, repeated callbacks,
length mismatches and a rejected oversized allocation. No claim of a full
security audit or mobile browser qualification follows from these tests.
