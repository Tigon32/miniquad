"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function fixture() {
    const windowEvents = new Map();
    const canvasEvents = new Map();
    const documentEvents = new Map();
    const received = [];
    const warnings = [];
    let allocations = 0;
    const memory = {buffer: new ArrayBuffer(2 * 1024 * 1024)};
    let next = 8;
    const canvas = {
        focus() {},
        addEventListener(name, callback) { canvasEvents.set(name, callback); },
        getBoundingClientRect() { return {left:0,top:0,width:640,height:480}; },
        clientWidth:640,clientHeight:480,width:640,height:480
    };
    const document = {
        querySelector(selector) { assert.equal(selector, "#glcanvas"); return canvas; },
        activeElement:canvas,
        hasFocus() {return true;},
        visibilityState:"visible",
        addEventListener(name, callback) {documentEvents.set(name,callback);},
        exitPointerLock() {}
    };
    const window = {
        addEventListener(name, callback) {windowEvents.set(name,callback);},
        requestAnimationFrame() {return 1;},
        cancelAnimationFrame() {}
    };
    const wasm = {
        allocate_transfer_vec_u8(n) {
            return this.allocate_vec_u8(n);
        },
        discard_transfer_vec_u8() {},
        allocate_vec_u8(len) {
            allocations++;
            assert.ok(Number.isSafeInteger(len) && len>=0);
            const start = next;
            next += len+8;
            assert.ok(next<memory.buffer.byteLength);
            return start;
        },
        on_clipboard_paste(pointer,length) {
            const bytes = new Uint8Array(memory.buffer,pointer,length);
            received.push({type:"paste",length,bytes:Array.from(bytes),
                text:new TextDecoder("utf-8",{fatal:true}).decode(bytes)});
        },
        key_down(code,mods,repeat) {received.push({type:"down",code,mods,repeat});},
        key_up(code,mods) {received.push({type:"up",code,mods});},
        key_press(code) {received.push({type:"press",code});},
        focus(hasFocus) {received.push({type:"focus",hasFocus});}
    };
    const context = vm.createContext({window,document,TextEncoder,console: {
        ...console,
        warn: message => warnings.push(message)
    }});
    vm.runInContext(source,context,{filename:"js/gl.js"});
    context.wasm_exports=wasm;
    context.wasm_memory=memory;
    vm.runInContext("importObject.env.run_animation_loop(false)",context);
    return {window,document,canvas,windowEvents,canvasEvents,documentEvents,received,
        warnings, get allocations() { return allocations; }, context};
}
function clipboardEvent(text) {
    let prevented=0, stopped=0;
    return {
        clipboardData: {getData() {return text;}, setData() {}},
        preventDefault() {prevented++;},
        stopPropagation() {stopped++;},
        get prevented() {return prevented;},
        get stopped() {return stopped;}
    };
}
test("clipboard paste preserves exact UTF-8 bytes and length",()=>{
    const f=fixture();
    for(const value of ["a","é","🎮","日本語","aé🎮\u0000z"]){
        const ev=clipboardEvent(value);
        f.windowEvents.get("paste")(ev);
        const got=f.received.at(-1);
        assert.equal(got.type,"paste");
        assert.equal(got.text,value);
        const expected=Array.from(new TextEncoder().encode(value));
        assert.equal(got.length,expected.length);
        assert.deepEqual(got.bytes,expected);
        assert.equal(ev.prevented,1);
        assert.equal(ev.stopped,1);
    }
});
test("clipboard paste ignores an unfocused canvas",()=>{
    const f=fixture();
    f.document.activeElement={id:"other-field"};
    const event=clipboardEvent("private text");
    f.windowEvents.get("paste")(event);
    assert.equal(event.prevented,0);
    assert.equal(event.stopped,0);
    assert.deepEqual(f.received,[]);
});
test("clipboard copy does not change a different focused field",()=>{
    const f=fixture();
    f.context.clipboard="example";
    f.document.activeElement={id:"other-field"};
    let copies=0,prevented=0;
    f.windowEvents.get("copy")({
        clipboardData:{setData(){copies++;}},
        preventDefault(){prevented++;}
    });
    assert.equal(copies,0);
    assert.equal(prevented,0);
});
test("Quote and Slash map to Rust ABI and produce one character event",()=>{
    const f=fixture();
    for(const [key,code] of [["Quote",39],["Slash",47]]){
        let prevented=0;
        f.canvas.onkeydown({
            code:key,repeat:false,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false,
            preventDefault(){prevented++;}
        });
        assert.equal(prevented,1);
        const result=f.received.slice(-2);
        assert.deepEqual(result,[
            {type:"down",code,mods:0,repeat:false},
            {type:"press",code}
        ]);
        f.canvas.onkeyup({
            code:key,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false
        });
        assert.deepEqual(f.received.at(-1),{type:"up",code,mods:0});
    }
});
test("Meta and modifier mapping preserves documented ABI values",()=>{
    const f=fixture();
    const value=vm.runInContext('into_sapp_keycode("MetaLeft")',f.context);
    assert.equal(value,343);
    const modifiers=vm.runInContext('into_sapp_modifiers({ctrlKey:true,shiftKey:true,altKey:true,metaKey:true})',f.context);
    assert.equal(modifiers,15);
});

test("clipboard paste rejects oversized ASCII before WASM allocation", () => {
    const f = fixture();
    const ev = clipboardEvent("a".repeat(1024 * 1024 + 1));
    f.windowEvents.get("paste")(ev);
    assert.equal(f.allocations, 0);
    assert.deepEqual(f.received, []);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /size limit exceeded/);
    assert.equal(ev.prevented, 1);
});

test("clipboard paste rejects multibyte UTF-8 over the byte limit", () => {
    const f = fixture();
    const ev = clipboardEvent("é".repeat(600000));
    f.windowEvents.get("paste")(ev);
    assert.equal(f.allocations, 0);
    assert.deepEqual(f.received, []);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /size limit exceeded/);
});

test("clipboard paste accepts a payload exactly at the byte limit", () => {
    const f = fixture();
    const text = "a".repeat(1024 * 1024);
    f.windowEvents.get("paste")(clipboardEvent(text));
    assert.equal(f.allocations, 1);
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].length, 1024 * 1024);
    assert.equal(f.received[0].text, text);
    assert.deepEqual(f.warnings, []);
});

test("clipboard paste ignores non-string data without allocating", () => {
    const f = fixture();
    const event = clipboardEvent({ arbitrary: true });
    f.windowEvents.get("paste")(event);
    assert.equal(f.allocations, 0);
    assert.deepEqual(f.received, []);
});

test("clipboard paste prefers standards-based text/plain MIME", () => {
    const f = fixture();
    const requested = [];
    const event = {
        clipboardData: {
            getData(type) {
                requested.push(type);
                return type === "text/plain" ? "é🎮" : "";
            }
        },
        preventDefault() {},
        stopPropagation() {}
    };
    f.windowEvents.get("paste")(event);
    assert.deepEqual(requested, ["text/plain"]);
    assert.equal(f.received.at(-1).text, "é🎮");
});
