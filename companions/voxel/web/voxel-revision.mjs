// Host-side full, true revision display for issue #29's mixed mode.
//
// The drawn (canvas) HUD caps its six-digit revision cell at `rEEEEEE`
// for any revision `>= 1_000_000` (see `hud::classify_revision` in
// `companions/voxel/src/hud.rs`): that is a *display* limit, not a
// transport error. The host's semantic, accessible status text has no
// such cap: it always shows the full, true `u32` revision.
//
// WASM export calls that return a Rust `u32` come back to JS as a
// *signed* 32-bit `Number` whenever the top bit is set: `vx_world_rev`
// returning the raw bits of `u32::MAX` (`0xFFFFFFFF`) is observed by
// the JS caller as `-1`, not `4294967295`, unless reinterpreted. `>>> 0`
// (unsigned right shift by zero) is the standard idiom for that
// reinterpretation; this module exists so that conversion happens in
// exactly one place and is covered by pure boundary tests.

/** Reinterprets a raw WASM export return value (a JS `Number` that may
 * have come back signed) as an unsigned 32-bit integer, e.g.
 * `-1 -> 4294967295`. */
export function toUnsignedU32(rawReturnValue) {
  return rawReturnValue >>> 0;
}

/** Full, uncapped, host-visible revision text.
 *
 * `hasSnapshot` mirrors the WASM side's `vx_has_snapshot()` export:
 * before the first applied snapshot, `vx_world_rev()` returns the
 * default `0`, which is otherwise indistinguishable from an actual
 * revision `0`. `rawWorldRev` is the raw (possibly signed) return
 * value of `vx_world_rev()`; it is unused when `hasSnapshot` is false.
 */
export function formatHostRevision(hasSnapshot, rawWorldRev) {
  if (!hasSnapshot) return "no snapshot yet";
  return String(toUnsignedU32(rawWorldRev));
}
