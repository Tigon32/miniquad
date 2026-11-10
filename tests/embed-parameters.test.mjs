import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParameters } from "../js/miniquad.mjs";

test("parameter contract preserves finite scalar and straight-alpha color values", () => {
    assert.deepEqual(validateParameters({
        speed: 0, foreground: [1, 0.5, 0, 1], background: [0, 0, 0, 0]
    }), [
        ["speed", 0], ["foreground", [1, 0.5, 0, 1]], ["background", [0, 0, 0, 0]]
    ]);
});

test("parameter contract rejects unbounded, malformed and unsupported input before WASM", () => {
    for (const value of [
        null, [], "speed", { speed: NaN }, { speed: Infinity }, { speed: -1 }, { speed: 3 },
        { foreground: [0, 0, 1] }, { background: [0, 0, 0, 2] },
        { foreground: [0, NaN, 0, 1] }, { foreground: [0, , 0, 1] },
        { resolution: 32 }, { speed: "1" }
    ]) {
        assert.throws(() => validateParameters(value), error => error.code === "invalid-parameters");
    }
});
