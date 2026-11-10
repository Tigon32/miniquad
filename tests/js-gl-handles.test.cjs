"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function createFixture() {
    const deleted = [];
    const bound = [];
    const errors = [];
    const memory = {buffer:new ArrayBuffer(1024)};
    const canvas = {focus() {}};
    const context = vm.createContext({
        document:{querySelector:()=>canvas,exitPointerLock(){}},
        window:{},
        console:{error:message=>errors.push(String(message)),log(){},warn(){}}
    });
    vm.runInContext(source,context,{filename:"js/gl.js"});
    context.wasm_memory = memory;
    context.gl = {
        deleteQuery(query) { deleted.push(query); },
        bindTexture(target,texture) { bound.push({target,texture}); }
    };
    const pointer=64;
    const putIds=(...ids)=>new Uint32Array(memory.buffer,pointer,ids.length).set(ids);
    return {context,errors,deleted,bound,pointer,putIds,env:vm.runInContext("importObject.env",context)};
}

test("glDeleteQueries uses the supplied pointer and deletes each live query once",()=>{
    const f=createFixture();
    vm.runInContext("GL.timerQueries[2]={name:2}; GL.timerQueries[5]={name:5};",f.context);
    f.putIds(2,5);
    f.env.glDeleteQueries(2,f.pointer);
    assert.deepEqual(f.deleted.map(x=>x.name),[0,0]);
    assert.equal(f.deleted.length,2);
    assert.equal(vm.runInContext("GL.timerQueries[2]",f.context),null);
    assert.equal(vm.runInContext("GL.timerQueries[5]",f.context),null);
    f.env.glDeleteQueries(2,f.pointer);
    assert.equal(f.deleted.length,2,"Repeated delete must not delete a stale handle");
    assert.deepEqual(f.errors,[]);
});
test("glDeleteQueries ignores zero and unknown handle IDs",()=>{
    const f=createFixture();
    f.putIds(0,99);
    f.env.glDeleteQueries(2,f.pointer);
    assert.deepEqual(f.deleted,[]);
    assert.deepEqual(f.errors,[]);
});
test("GL validation reports invalid and deleted texture IDs without undefined references",()=>{
    const f=createFixture();
    f.env.glBindTexture(3553,999);
    assert.equal(f.errors.length,1);
    assert.match(f.errors[0],/glBindTexture called with an invalid texture ID 999/);
    vm.runInContext("GL.textures[7] = null",f.context);
    f.env.glBindTexture(3553,7);
    assert.equal(f.errors.length,2);
    assert.match(f.errors[1],/glBindTexture called with an already deleted texture ID 7/);
});
test("GL validation does not reject a zero texture handle",()=>{
    const f=createFixture();
    f.env.glBindTexture(3553,0);
    assert.equal(f.errors.length,0);
    assert.equal(f.bound.length,1);
});

test("invalid and deleted texture handles do not reach host WebGL", () => {
    const f=createFixture();
    f.env.glBindTexture(3553,999);
    vm.runInContext("GL.textures[7] = null",f.context);
    f.env.glBindTexture(3553,7);
    assert.deepEqual(f.bound,[]);
    assert.match(f.errors[0],/invalid texture ID 999/);
    assert.match(f.errors[1],/already deleted texture ID 7/);
});

test("valid texture handles still bind through WebGL", () => {
    const f=createFixture();
    vm.runInContext("GL.textures[4] = {name:4}",f.context);
    f.env.glBindTexture(3553,4);
    assert.equal(f.bound.length,1);
    assert.equal(f.bound[0].texture.name,4);
});

test("WebGL2-only framebuffer imports fail explicitly in WebGL1", () => {
    const f=createFixture();
    assert.throws(()=>f.env.glReadBuffer(0x8ce0),/glReadBuffer requires a WebGL2 context/);
    assert.throws(()=>f.env.glBlitFramebuffer(0,0,2,2,0,0,2,2,0x4000,0x2600),
        /glBlitFramebuffer requires a WebGL2 context/);
});

test("WebGL2 framebuffer operations forward parameters unchanged", () => {
    const f=createFixture();
    const calls=[];
    f.context.gl.readBuffer=(source)=>calls.push({name:"read",source});
    f.context.gl.blitFramebuffer=(...args)=>calls.push({name:"blit",args});
    f.env.glReadBuffer(0x8ce0);
    f.env.glBlitFramebuffer(0,0,2,2,0,0,2,2,0x4000,0x2600);
    assert.deepEqual(calls,[
        {name:"read",source:0x8ce0},
        {name:"blit",args:[0,0,2,2,0,0,2,2,0x4000,0x2600]}
    ]);
});

test("WebGL1 depth texture use fails without extension, color still works", () => {
    const f = createFixture();
    const calls = [];
    f.context.gl.DEPTH_COMPONENT = 0x1902;
    f.context.gl.DEPTH_STENCIL = 0x84f9;
    f.context.gl.texImage2D = (...args) => calls.push(args);
    f.context.webgl_depth_texture_supported = false;
    assert.throws(() => f.env.glTexImage2D(3553, 0, 0x1902, 1, 1, 0, 0x1902, 5123, 0),
        /WebGL1 depth textures are unavailable/);
    assert.equal(calls.length, 0);
    f.env.glTexImage2D(3553, 0, 0x1908, 1, 1, 0, 0x1908, 5121, 0);
    assert.equal(calls.length, 1);
    f.context.webgl_depth_texture_supported = true;
    f.env.glTexImage2D(3553, 0, 0x1902, 1, 1, 0, 0x1902, 5123, 0);
    assert.equal(calls.length, 2);
});
