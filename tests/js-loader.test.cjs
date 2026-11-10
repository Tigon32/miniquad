"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");

function createFixture({ streaming = true, imports = [], crateVersion = 2, responseStatus = 200,
                         missingExports = false } = {}) {
    const calls = { fetch: 0, compile: 0, instantiate: 0, main: 0, errors: [] };
    const canvas = { focus() {} };
    const document = { querySelector: () => canvas, exitPointerLock() {} };
    const compiled = { marker: "compiled" };
    const wasm = {
        Module: { imports: () => imports },
        compile: async () => { calls.compile++; return compiled; },
        instantiate: async (module, object) => {
            assert.equal(module, compiled);
            assert.ok(object.env);
            calls.instantiate++;
            return {
                exports: {
                    ...(missingExports ? {} : {
                        memory: { buffer: new ArrayBuffer(65536) },
                        crate_version: () => crateVersion,
                        main: () => { calls.main++; }
                    })
                }
            };
        }
    };
    if (streaming) wasm.compileStreaming = async (promise) => {
        const response = await promise;
        assert.equal(response.status, 200);
        calls.compile++;
        return compiled;
    };
    const sandbox = {
        document, window: {}, WebAssembly: wasm,
        fetch: async (url) => {
            calls.fetch++;
            assert.equal(url, "quad.wasm");
            return { ok: responseStatus === 200, status: responseStatus, arrayBuffer: async () => new ArrayBuffer(4) };
        },
        console: { error: (...args) => calls.errors.push(args.map(String).join(" ")), warn() {}, log() {} }
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: "js/gl.js" });
    return {
        calls,
        context,
        load: () => vm.runInContext('load("quad.wasm")', context),
        getImport: name => vm.runInContext('importObject.env[' + JSON.stringify(name) + ']', context)
    };
}

for (const streaming of [true, false]) {
    test("valid WASM module starts with " + (streaming ? "streaming" : "fallback") + " compilation", async () => {
        const fixture = createFixture({ streaming, imports: [{module:"env", name:"init_webgl", kind:"function"}] });
        await fixture.load();
        assert.equal(fixture.calls.fetch, 1);
        assert.equal(fixture.calls.compile, 1);
        assert.equal(fixture.calls.instantiate, 1);
        assert.equal(fixture.calls.main, 1);
        assert.equal(fixture.calls.errors.length, 0);
    });
    test("missing import fails before instantiate in " + (streaming ? "streaming" : "fallback") + " path", async () => {
        const fixture = createFixture({ streaming, imports: [{module:"env",name:"missing_required_import",kind:"function"}] });
        await assert.rejects(fixture.load(), /Missing required WASM import: env.missing_required_import/);
        assert.equal(fixture.calls.instantiate, 0);
        assert.equal(fixture.calls.main, 0);
        assert.equal(fixture.getImport("missing_required_import"), undefined);
    });
    test("wrong ABI version cannot call main in " + (streaming ? "streaming" : "fallback") + " path", async () => {
        const fixture = createFixture({ streaming, crateVersion: 999 });
        await assert.rejects(fixture.load(), /WASM ABI version mismatch/);
        assert.equal(fixture.calls.instantiate, 1);
        assert.equal(fixture.calls.main, 0);
    });
    test("HTTP error cannot compile or start WASM in " + (streaming ? "streaming" : "fallback") + " path", async () => {
        const fixture = createFixture({ streaming, responseStatus: 404 });
        await assert.rejects(fixture.load(), /WASM HTTP request failed: 404/);
        assert.equal(fixture.calls.instantiate, 0);
        assert.equal(fixture.calls.main, 0);
    });
}

test("a required export must exist before startup", async () => {
    const fixture = createFixture({ missingExports:true });
    await assert.rejects(fixture.load(), /WASM module is missing required exports/);
    assert.equal(fixture.calls.main, 0);
});

test("plugin registers imports before module validation", async () => {
    const fixture = createFixture({imports:[{module:"env",name:"custom_import",kind:"function"}]});
    vm.runInContext('miniquad_add_plugin({register_plugin(imports){ imports.env.custom_import = () => 42; }})', fixture.context);
    await fixture.load();
    assert.equal(fixture.calls.main, 1);
    assert.equal(typeof fixture.getImport("custom_import"), "function");
});
