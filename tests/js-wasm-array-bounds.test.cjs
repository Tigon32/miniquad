"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridge = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function fixture() {
    const context = vm.createContext({
        document: { querySelector: () => ({ focus() {} }), exitPointerLock() {} },
        window: {},
        console
    });
    vm.runInContext(bridge, context, { filename: "js/gl.js" });
    context.wasm_memory = { buffer: new ArrayBuffer(64) };
    return {
        view(ptr, type, count) {
            context.__ptr = ptr;
            context.__count = count;
            return vm.runInContext("getArray(__ptr, " + type + ", __count)", context);
        }
    };
}

test("valid exact-end byte and word WASM views are accepted", () => {
    const f = fixture();
    assert.equal(f.view(64, "Uint8Array", 0).length, 0);
    assert.equal(f.view(63, "Uint8Array", 1).length, 1);
    assert.equal(f.view(60, "Uint32Array", 1).length, 1);
    assert.equal(f.view(0, "Float32Array", 16).length, 16);
});

test("out-of-bounds, unaligned and fractional typed array requests are rejected", () => {
    const f = fixture();
    for (const [ptr, type, count] of [
        [-1, "Uint8Array", 1],
        [65, "Uint8Array", 0],
        [64, "Uint8Array", 1],
        [61, "Uint32Array", 1],
        [2, "Uint32Array", 1],
        [0, "Uint32Array", 17],
        [0, "Float32Array", -1],
        [1.5, "Uint8Array", 1],
        [0, "Uint8Array", 0.5],
        [Number.MAX_SAFE_INTEGER, "Uint8Array", 2],
        [NaN, "Uint8Array", 2],
        [0, "Uint8Array", Infinity]
    ]) {
        assert.throws(() => f.view(ptr, type, count), /Invalid WASM typed-array memory range/);
    }
});
