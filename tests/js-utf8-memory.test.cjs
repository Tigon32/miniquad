"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function fixture() {
    const canvas = { focus() {} };
    const memory = { buffer: new ArrayBuffer(64) };
    const context = vm.createContext({
        window: {},
        document: { querySelector: () => canvas, exitPointerLock() {} },
        console,
        TextDecoder
    });
    vm.runInContext(source, context, { filename: "js/gl.js" });
    context.wasm_memory = memory;
    return {
        memory,
        read: (ptr, len) => {
            context.__testPtr = ptr;
            context.__testLen = len;
            return vm.runInContext("UTF8ToString(__testPtr, __testLen)", context);
        }
    };
}

test("NUL-terminated strings stop before other memory", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 4, 5).set([65, 66, 0, 67, 68]);
    assert.equal(f.read(4), "AB");
});

test("unterminated strings are bounded by the WASM memory end", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 61, 3).set([88, 89, 90]);
    assert.equal(f.read(61), "XYZ");
    assert.equal(f.read(64), "");
});

test("explicit byte lengths do not read past their range", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 8, 4).set([65, 66, 67, 68]);
    assert.equal(f.read(8, 2), "AB");
    assert.equal(f.read(8, 0), "");
});

test("invalid pointers and lengths reject before reading", () => {
    const f = fixture();
    for (const [ptr, length] of [
        [-1, 1], [65, undefined], [63, 2], [1, -1],
        [1.5, 2], [NaN, undefined], [1, Infinity], [1, 0.5]
    ]) {
        assert.throws(() => f.read(ptr, length), /Invalid WASM UTF-8 memory range/);
    }
});

test("malformed and truncated UTF-8 is decoded without reading adjacent bytes", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 8, 5).set([0xc3, 0x28, 0xf0, 0x9f, 0x8e]);
    assert.equal(f.read(8, 2), "\ufffd(");
    assert.equal(f.read(10, 3), "\ufffd");
});

test("valid multibyte text preserves full codepoints inside the byte range", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 12, 6).set([0xc3, 0xa9, 0xf0, 0x9f, 0x8e, 0xae]);
    assert.equal(f.read(12, 6), "é🎮");
    assert.equal(f.read(12, 2), "é");
});
