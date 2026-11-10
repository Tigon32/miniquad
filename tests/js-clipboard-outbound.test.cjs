"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function fixture() {
    const canvas = { focus() {} };
    const memory = { buffer: new ArrayBuffer(4096) };
    const context = vm.createContext({
        document: { querySelector() { return canvas; }, exitPointerLock() {} },
        window: {},
        TextDecoder,
        console
    });
    vm.runInContext(source, context, { filename: "js/gl.js" });
    context.wasm_memory = memory;
    return {
        memory,
        context,
        setClipboard: (ptr, len) => vm.runInContext('importObject.env.sapp_set_clipboard', context)(ptr, len),
        clipboard: () => vm.runInContext("clipboard", context)
    };
}

test("outbound clipboard transfers UTF-8 by byte length, including embedded NUL", () => {
    const f = fixture();
    const values = ["", "hello", "é", "🎮", "a\u0000b", "日本語🎮\u0000z"];
    let offset = 8;
    for (const text of values) {
        const bytes = new TextEncoder().encode(text);
        new Uint8Array(f.memory.buffer, offset, bytes.length).set(bytes);
        f.setClipboard(offset, bytes.length);
        assert.equal(f.clipboard(), text);
        offset += bytes.length + 8;
    }
});

test("invalid clipboard memory ranges reject without changing previous value", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 8, 2).set([79, 75]);
    f.setClipboard(8, 2);
    for (const [ptr, len] of [
        [-1, 1], [0, -1], [4095, 2], [4097, 0],
        [1.5, 2], [8, Number.MAX_SAFE_INTEGER], [NaN, 2],
        [Infinity, 1]
    ]) {
        assert.throws(() => f.setClipboard(ptr, len), /Invalid WASM clipboard memory range/);
        assert.equal(f.clipboard(), "OK");
    }
});

test("malformed UTF-8 is rejected without mutating clipboard", () => {
    const f = fixture();
    new Uint8Array(f.memory.buffer, 8, 2).set([79, 75]);
    f.setClipboard(8, 2);
    new Uint8Array(f.memory.buffer, 32, 2).set([0xc3, 0x28]);
    assert.throws(() => f.setClipboard(32, 2), /encoded data|valid/i);
    assert.equal(f.clipboard(), "OK");
});
