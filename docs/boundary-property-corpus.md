# Deterministic JavaScript/WASM boundary property corpus

* Date: 2026-11-10
* Source baseline: `874bd443f05ed5b0562ad6d2cfbafdcd05f084b8`
* Tracking: [boundary tests #21](https://github.com/Tigon32/miniquad/issues/21)
* ABI: [browser transfer contract](abi-v3-contract.md)

Run `node --test tests/js-boundary-properties.test.cjs`.

The tests use a fixed linear-congruential generator (no external package).
The UTF-8 corpus contains 1500 pseudo-random byte sequences, offsets and
lengths, including NUL delimiters and malformed UTF-8. Its independent
reference is `TextDecoder` on the bounded byte range. The second corpus
tests 2500 typed-array requests across 8/16/32-bit integer and floating-point
element widths. Its oracle independently checks pointer alignment, count and
memory end before comparing the behavior of the checked-in `getArray`.

The seed is `0x5eedcafe`, with a second stream seeded by XOR
`0x13579bdf`. On any failure, the assertion includes seed and case index.
The test prints wall time (milliseconds) and resident memory (bytes) so the
default CI cost can be monitored. There are no intentionally ignored
cases and no network access.

Scope limits: A deterministic corpus is **not** exhaustive fuzzing and
does not establish Rust memory safety against a hostile same-origin script.
The `UTF8ToString` implementation itself uses a TextDecoder, so the first
comparison is mainly a bounds/NUL-handling regression rather than an
independent UTF-8 algorithm validator. The typed-array reference oracle
does not enumerate all WebGL API argument combinations.

Existing test suites cover unknown keyboard codes, focus transitions,
zero-length clipboard transfers, invalid file drops, stale resource IDs
and WebGL context loss. A larger campaign can be run manually with varied
seeds and minimized reproductions; any new failure must be retained in a
stable regression test rather than suppressed.
