"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

// Real WebGL/GLES3 enum values (not arbitrary test doubles): a wrong mapping
// here would silently pass against stub values that do not match the spec.
const DEPTH_COMPONENT = 0x1902;
const DEPTH_COMPONENT16 = 0x81a5;
const DEPTH_COMPONENT24 = 0x81a6;
const DEPTH_COMPONENT32F = 0x8cac;
const DEPTH_STENCIL = 0x84f9;
const RGBA = 0x1908;
const UNSIGNED_BYTE = 0x1401;
const UNSIGNED_SHORT = 0x1403;
const UNSIGNED_INT = 0x1405;
const FLOAT = 0x1406;

function createFixture() {
    const texImage2DCalls = [];
    const memory = {buffer:new ArrayBuffer(1024)};
    const canvas = {focus() {}};
    const context = vm.createContext({
        document:{querySelector:()=>canvas,exitPointerLock(){}},
        window:{},
        console:{error(){},log(){},warn(){}}
    });
    vm.runInContext(source,context,{filename:"js/gl.js"});
    context.wasm_memory = memory;
    context.gl = {
        DEPTH_COMPONENT,DEPTH_COMPONENT16,DEPTH_COMPONENT24,DEPTH_COMPONENT32F,
        DEPTH_STENCIL,RGBA,UNSIGNED_BYTE,UNSIGNED_SHORT,UNSIGNED_INT,FLOAT,
        texImage2D(...args) { texImage2DCalls.push(args); }
    };
    return {context,texImage2DCalls,env:vm.runInContext("importObject.env",context)};
}

// glTexImage2D(target, level, internalFormat, width, height, border, format, type, pixels)
const TARGET_TEXTURE_2D = 0x0de1;

test("WebGL2 depth texture: unsized DEPTH_COMPONENT + UNSIGNED_SHORT becomes sized DEPTH_COMPONENT16",()=>{
    const f=createFixture();
    vm.runInContext("webgl2_context = true; webgl_depth_texture_supported = true;",f.context);
    f.env.glTexImage2D(TARGET_TEXTURE_2D,0,DEPTH_COMPONENT,256,256,0,DEPTH_COMPONENT,UNSIGNED_SHORT,0);
    assert.equal(f.texImage2DCalls.length,1);
    const [,,internalFormat,,,,format,type]=f.texImage2DCalls[0];
    assert.equal(internalFormat,DEPTH_COMPONENT16,
        "WebGL2/GLES3 requires a sized internalformat for depth texImage2D; an unsized value leaves the attachment non-renderable on strict engines (observed on WebKit 27.2)");
    assert.equal(format,DEPTH_COMPONENT);
    assert.equal(type,UNSIGNED_SHORT);
});

test("WebGL2 depth texture: unsized DEPTH_COMPONENT + UNSIGNED_INT becomes sized DEPTH_COMPONENT24",()=>{
    const f=createFixture();
    vm.runInContext("webgl2_context = true; webgl_depth_texture_supported = true;",f.context);
    f.env.glTexImage2D(TARGET_TEXTURE_2D,0,DEPTH_COMPONENT,256,256,0,DEPTH_COMPONENT,UNSIGNED_INT,0);
    const [,,internalFormat]=f.texImage2DCalls[0];
    assert.equal(internalFormat,DEPTH_COMPONENT24);
});

test("WebGL2 depth texture: unsized DEPTH_COMPONENT + FLOAT becomes sized DEPTH_COMPONENT32F",()=>{
    const f=createFixture();
    vm.runInContext("webgl2_context = true; webgl_depth_texture_supported = true;",f.context);
    f.env.glTexImage2D(TARGET_TEXTURE_2D,0,DEPTH_COMPONENT,256,256,0,DEPTH_COMPONENT,FLOAT,0);
    const [,,internalFormat]=f.texImage2DCalls[0];
    assert.equal(internalFormat,DEPTH_COMPONENT32F);
});

test("WebGL1 depth texture (WEBGL_depth_texture extension) keeps the unsized DEPTH_COMPONENT internalformat",()=>{
    const f=createFixture();
    // WebGL1 context with the WEBGL_depth_texture extension granted.
    vm.runInContext("webgl2_context = false; webgl_depth_texture_supported = true;",f.context);
    f.env.glTexImage2D(TARGET_TEXTURE_2D,0,DEPTH_COMPONENT,256,256,0,DEPTH_COMPONENT,UNSIGNED_SHORT,0);
    const [,,internalFormat]=f.texImage2DCalls[0];
    assert.equal(internalFormat,DEPTH_COMPONENT,
        "The WEBGL_depth_texture extension requires the unsized DEPTH_COMPONENT internalformat; translating it would break WebGL1");
});

test("WebGL2 color texture internalformat is left unchanged",()=>{
    const f=createFixture();
    vm.runInContext("webgl2_context = true; webgl_depth_texture_supported = true;",f.context);
    f.env.glTexImage2D(TARGET_TEXTURE_2D,0,RGBA,256,256,0,RGBA,UNSIGNED_BYTE,0);
    const [,,internalFormat,,,,format,type]=f.texImage2DCalls[0];
    assert.equal(internalFormat,RGBA);
    assert.equal(format,RGBA);
    assert.equal(type,UNSIGNED_BYTE);
});

test("WebGL1 without WEBGL_depth_texture still rejects depth formats",()=>{
    const f=createFixture();
    vm.runInContext("webgl2_context = false; webgl_depth_texture_supported = false;",f.context);
    assert.throws(()=>{
        f.env.glTexImage2D(TARGET_TEXTURE_2D,0,DEPTH_COMPONENT,256,256,0,DEPTH_COMPONENT,UNSIGNED_SHORT,0);
    },/WebGL1 depth textures are unavailable/);
});
