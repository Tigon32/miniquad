"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const source=fs.readFileSync(path.resolve(__dirname,"../js/gl.js"),"utf8");

function fixture(clock) {
    const canvas={focus(){}};
    const context=vm.createContext({
        window:{performance:clock.performance},
        document:{querySelector:()=>canvas},
        Date:{now:()=>clock.wallMs},
        console
    });
    vm.runInContext(source,context,{filename:"js/gl.js"});
    const fn=vm.runInContext("importObject.env.now",context);
    return {now:()=>fn(),clock};
}

test("epoch seconds use monotonic high-resolution time with reduced precision",()=>{
    const clock={performance:{timeOrigin:1_700_000_000_000,now:()=>clock.elapsedMs},elapsedMs:100,wallMs:1};
    const f=fixture(clock);
    assert.equal(f.now(),1_700_000_000.1);
    clock.elapsedMs=100; // Firefox privacy mode can quantize repeated readings.
    assert.equal(f.now(),1_700_000_000.1);
    clock.elapsedMs=98; // An imprecise backward observation must not rewind the game clock.
    assert.equal(f.now(),1_700_000_000.1);
    clock.elapsedMs=250;
    assert.equal(f.now(),1_700_000_000.25);
});

test("clock preserves epoch-seconds contract and falls back if performance is unavailable",()=>{
    const clock={performance:undefined,wallMs:1_700_000_000_123};
    const f=fixture(clock);
    assert.equal(f.now(),1_700_000_000.123);
    clock.wallMs-=5000;
    assert.equal(f.now(),1_700_000_000.123);
    clock.wallMs+=6000;
    assert.equal(f.now(),1_700_000_001.123);
});

test("unavailable or non-finite clock fails visibly rather than exporting NaN",()=>{
    const clock={performance:{timeOrigin:NaN,now:()=>99},wallMs:NaN};
    const f=fixture(clock);
    assert.throws(f.now,/Browser time source is unavailable/);
});
