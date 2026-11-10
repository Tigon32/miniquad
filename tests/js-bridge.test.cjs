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
    const messages = [];
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
        console: {
            ...console,
            warn: (...args) => messages.push({ kind: "warn", args }),
            error: (...args) => messages.push({ kind: "error", args })
        },
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
        messages,
        async malformedDrop(dataTransfer) {
            await window.ondrop({ preventDefault() {}, dataTransfer });
            return events;
        },
        async dropRaw(files) {
            await window.ondrop({ preventDefault() {}, dataTransfer: { files } });
            return events;
        },
        async drop(files) {
            return this.dropRaw(files.map(([name, bytes]) => ({
                name,
                size: bytes.length,
                async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
            })));
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

test("file drops reject files above the per-file limit before reading", async () => {
    const harness = createBrowserBridge();
    let readCount = 0;
    await harness.dropRaw([{
        name: "too-large.dat",
        size: 32 * 1024 * 1024 + 1,
        async arrayBuffer() { readCount++; throw new Error("must not read"); }
    }]);
    assert.equal(readCount, 0);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "finish"]);
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 1);
});

test("file drops reject oversized buffers after reading", async () => {
    const harness = createBrowserBridge();
    await harness.dropRaw([{
        name: "wrong-size.bin",
        size: 1,
        async arrayBuffer() { return new ArrayBuffer(32 * 1024 * 1024 + 1); }
    }]);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "finish"]);
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 1);
});

test("failed file reads do not prevent later files or completion", async () => {
    const harness = createBrowserBridge();
    await harness.dropRaw([
        { name: "missing.bin", size: 1, async arrayBuffer() { throw new Error("read failed"); } },
        { name: "ok.bin", size: 2, async arrayBuffer() { return Uint8Array.of(9, 8).buffer; } }
    ]);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "file", "finish"]);
    assert.equal(harness.events[1].name, "ok.bin");
    assert.deepEqual(harness.events[1].bytes, [9, 8]);
    assert.equal(harness.messages.filter(m => m.kind === "error").length, 1);
});

test("overlapping file-drop events execute one transaction at a time", async () => {
    const harness = createBrowserBridge();
    let releaseFirst;
    const pending = new Promise(resolve => { releaseFirst = resolve; });
    const first = harness.dropRaw([{
        name: "first.bin", size: 1, async arrayBuffer() { return pending; }
    }]);
    // Let the first queued drop start and wait for the file.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.events.map(e => e.kind), ["start"]);
    const second = harness.dropRaw([{
        name: "second.bin", size: 1, async arrayBuffer() { return Uint8Array.of(2).buffer; }
    }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.events.map(e => e.kind), ["start"]);
    releaseFirst(Uint8Array.of(1).buffer);
    await Promise.all([first, second]);
    assert.deepEqual(harness.events.map(e => e.kind), [
        "start", "file", "finish", "start", "file", "finish"
    ]);
    assert.equal(harness.events[1].name, "first.bin");
    assert.equal(harness.events[4].name, "second.bin");
});

test("file drops cap the file count before reading extra files", async () => {
    const harness = createBrowserBridge();
    let reads = 0;
    const files = Array.from({ length: 130 }, (_, n) => ({
        name: `file-${n}.bin`,
        size: 1,
        async arrayBuffer() {
            reads++;
            return Uint8Array.of(1).buffer;
        }
    }));
    await harness.dropRaw(files);
    assert.equal(reads, 128);
    assert.equal(harness.events.filter(e => e.kind === "file").length, 128);
    assert.deepEqual([harness.events[0].kind, harness.events.at(-1).kind], ["start", "finish"]);
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 1);
});

test("file drops reject oversized UTF-8 filename before reading", async () => {
    const harness = createBrowserBridge();
    let reads = 0;
    await harness.dropRaw([{
        name: "é".repeat(2049),
        size: 1,
        async arrayBuffer() { reads++; return Uint8Array.of(1).buffer; }
    }, {
        name: "ok.bin",
        size: 1,
        async arrayBuffer() { reads++; return Uint8Array.of(2).buffer; }
    }]);
    assert.equal(reads, 1);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "file", "finish"]);
    assert.equal(harness.events[1].name, "ok.bin");
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 1);
});

test("file drops reject invalid declared sizes before reading", async () => {
    const harness = createBrowserBridge();
    let reads = 0;
    await harness.dropRaw([NaN, -1, Infinity, 1.5].map((size, i) => ({
        name: `bad-${i}.bin`,
        size,
        async arrayBuffer() { reads++; return Uint8Array.of(1).buffer; }
    })));
    assert.equal(reads, 0);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "finish"]);
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 4);
});

test("file drop queue rejects excess transactions while a read is blocked", async () => {
    const harness = createBrowserBridge();
    let releaseFirst;
    const pending = new Promise(resolve => { releaseFirst = resolve; });
    const first = harness.dropRaw([{
        name: "blocked.bin",
        size: 1,
        async arrayBuffer() { return pending; }
    }]);
    await new Promise(resolve => setImmediate(resolve));
    const queued = [];
    for (let index = 1; index < 10; index++) {
        queued.push(harness.dropRaw([{
            name: `next-${index}.bin`,
            size: 1,
            async arrayBuffer() { return Uint8Array.of(index).buffer; }
        }]));
    }
    assert.deepEqual(harness.events.map(e => e.kind), ["start"]);
    releaseFirst(Uint8Array.of(0).buffer);
    await Promise.all([first, ...queued]);
    assert.equal(harness.events.filter(e => e.kind === "file").length, 8);
    assert.equal(harness.events.filter(e => e.kind === "start").length, 8);
    assert.equal(harness.events.filter(e => e.kind === "finish").length, 8);
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 2);

    // Completion releases queue slots for later user input.
    await harness.drop([["after.bin", [42]]]);
    assert.equal(harness.events.filter(e => e.kind === "file").length, 9);
});

test("failed drop transactions release a pending queue slot", async () => {
    const harness = createBrowserBridge();
    await assert.rejects(harness.dropRaw([{
        name: "invalid.bin", size: 1,
        async arrayBuffer() { return Uint8Array.of(1).buffer; }
    }, {
        name: "throw.bin", size: 1,
        get size() { throw new Error("invalid file metadata"); }
    }]), /invalid file metadata/);
    await harness.drop([["after-error.bin", [2]]]);
    assert.equal(harness.events.at(-2).name, "after-error.bin");
    assert.equal(harness.events.at(-1).kind, "finish");
});

test("malformed drop lists cannot consume queue capacity", async () => {
    const harness = createBrowserBridge();
    for (let n = 0; n < 10; n++) {
        await harness.malformedDrop(null);
    }
    await harness.malformedDrop({ files: { length: -1 } });
    await harness.malformedDrop({ files: {
        length: 1,
        get 0() { throw new Error("bad list"); }
    } });
    await harness.drop([["after-invalid.bin", [8]]]);
    assert.deepEqual(harness.events.map(e => e.kind), ["start", "file", "finish"]);
    assert.equal(harness.events[1].name, "after-invalid.bin");
    assert.equal(harness.messages.filter(m => m.kind === "warn").length, 12);
});
