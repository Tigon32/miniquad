// Pure boundary tests for companions/voxel/web/voxel-revision.mjs: the
// host-side full, uncapped revision display and its unsigned WASM u32
// conversion. Required boundaries per the #29 acceptance correction:
// None (no snapshot), 0, 42, 999999, 1000000, and u32::MAX
// (0xFFFFFFFF), with an explicit host-side unsigned-conversion
// assertion that 0xFFFFFFFF becomes 4294967295, not a negative number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toUnsignedU32, formatHostRevision } from "../companions/voxel/web/voxel-revision.mjs";

test("toUnsignedU32 reinterprets a signed WASM export return value as unsigned, e.g. 0xFFFFFFFF -> 4294967295", () => {
  // A raw u32::MAX bit pattern, as a JS engine would hand it back from
  // a WASM i32-typed export call (top bit set -> negative signed).
  assert.equal(0xffffffff | 0, -1);
  assert.equal(toUnsignedU32(-1), 4294967295);
  assert.equal(toUnsignedU32(0xffffffff), 4294967295);
  assert.equal(toUnsignedU32(0), 0);
  assert.equal(toUnsignedU32(42), 42);
});

test("formatHostRevision shows 'no snapshot yet' when hasSnapshot is false, regardless of the raw return value", () => {
  assert.equal(formatHostRevision(false, 0), "no snapshot yet");
  assert.equal(formatHostRevision(false, -1), "no snapshot yet");
});

test("formatHostRevision shows the full, uncapped decimal revision at every required boundary", () => {
  assert.equal(formatHostRevision(true, 0), "0");
  assert.equal(formatHostRevision(true, 42), "42");
  assert.equal(formatHostRevision(true, 999999), "999999");
  // The *drawn* HUD caps display at rev >= 1_000_000 (hud::classify_revision
  // renders "EEEEEE"); the host's semantic text has no such cap.
  assert.equal(formatHostRevision(true, 1000000), "1000000");
  assert.equal(formatHostRevision(true, -1), "4294967295");
});
