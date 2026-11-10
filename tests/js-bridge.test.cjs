"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridge = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function createBrowserBridge() {
    const canvasHandlers = new Map();
    const windowHandlers = new Map();
    const documentHandlers = new Map();
    const events = [];
    const memory = { buffer: new ArrayBuffer(1024 * 1024) };
    let cursor = 8;

    const canvas = {
        focus() {},
        addEventListener(name, handler) { canvasHandlers.set(name, handler); }
    };
    const window = {
        addEventListener(name, handler) { windowHandlers.set(name, handler); },
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() {}
    };
    const document = {
        querySelector(selector) { assert.equal(selector, "#glcanvas"); return canvas; },
        hasFocus() { return true; },
        addEventListener(name, handler) { documentHandlers.set(name, handler); },
        visibilityState: "visible",
        activeElement: canvas
    };
    const wasm = {
        allocate_vec_u8(n) {
            assert.ok(Number.isInteger(n) && n >= 0, "allocation size must be an unsigned byte count");
            const ptr = cursor;
            cursor += n + 8;
            assert.ok(cursor < memory.buffer.byteLength, "fixture memory capacity");
            return ptr;
        },
        on_files_dropped_start() { events.push({ kind: "start" }); },
        on_file_dropped(namePtr, nameLen, filePtr, fileLen) {
            const nameBytes = new Uint8Array(memory.buffer, namePtr, nameLen);
            const fileBytes = new Uint8Array(memory.buffer, filePtr, fileLen);
            events.push({
                kind: "file",
                name: new TextDecoder("utf-8", { fatal: true }).decode(nameBytes),
                nameLen,
                bytes: Array.from(fileBytes)
            });
        },
        on_files_dropped_finish() { events.push({ kind: "finish" }); }
    };
    const context = vm.createContext({
        document,
        window,
        TextEncoder,
        console,
        setTimeout() {},
        clearTimeout() {}
    });
    vm.runInContext(bridge, context, { filename: "js/gl.js" });
    context.wasm_memory = memory;
    context.wasm_exports = wasm;
    vm.runInContext("importObject.env.run_animation_loop(false)", context);
    assert.equal(typeof window.ondrop, "function");
    return {
        events,
        async drop(files) {
            await window.ondrop({
                preventDefault() {},
                dataTransfer: { files: files.map(([name, bytes]) => ({
                    name,
                    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
                })) }
            });
            return events;
        }
    };
}

test("dropped filenames preserve exact UTF-8 bytes and Rust-visible length", async () => {
    const cases = [
        ["ascii.txt", [1]],
        ["é.txt", [2, 3]],
        ["日本語.txt", [4]],
        ["🎮.vox", [5, 6]],
        ["aé🎮.vox", []]
    ];
    const harness = createBrowserBridge();
    const events = await harness.drop(cases);
    assert.equal(events[0].kind, "start");
    assert.equal(events.at(-1).kind, "finish");
    assert.equal(events.length, cases.length + 2);
    cases.forEach(([name, bytes], index) => {
        const event = events[index + 1];
        assert.equal(event.kind, "file");
        assert.equal(event.name, name);
        assert.equal(event.nameLen, new TextEncoder().encode(name).byteLength);
        assert.deepEqual(event.bytes, bytes);
    });
});

test("empty file contents and non-ASCII filename survive drop", async () => {
    const harness = createBrowserBridge();
    const events = await harness.drop([["café.txt", []]]);
    assert.equal(events[1].name, "café.txt");
    assert.equal(events[1].nameLen, new TextEncoder().encode("café.txt").length);
    assert.deepEqual(events[1].bytes, []);
});
