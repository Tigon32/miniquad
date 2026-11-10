"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const source = fs.readFileSync(path.resolve(__dirname, "../js/gl.js"), "utf8");
const SEED = 0x5eedcafe;
function generator(seed) {
    let state=seed>>>0;
    return maximum => {
        state=(Math.imul(state,1664525)+1013904223)>>>0;
        return state%maximum;
    };
}
function fixture() {
    const memory={buffer:new ArrayBuffer(256)};
    const context=vm.createContext({
        document:{querySelector:()=>({focus(){}}),exitPointerLock(){}},
        window:{},
        console, TextDecoder
    });
    vm.runInContext(source,context,{filename:"js/gl.js"});
    context.wasm_memory=memory;
    return {memory,context};
}
function invoke(context,source,ptr,len){
    context.__ptr=ptr;
    context.__len=len;
    return vm.runInContext(source,context);
}
test("deterministic UTF-8 fuzz corpus matches bounded standard decoding",()=>{
    const random=generator(SEED);
    const f=fixture();
    const bytes=new Uint8Array(f.memory.buffer);
    const decoder=new TextDecoder("utf-8");
    const start=performance.now();
    for(let caseIndex=0;caseIndex<1500;caseIndex++){
        for(let i=0;i<bytes.length;i++)bytes[i]=random(256);
        const offset=random(257);
        const length=random(257-offset);
        const slice=bytes.subarray(offset,offset+length);
        const nul=slice.indexOf(0);
        const expected=decoder.decode(slice.subarray(0,nul<0?slice.length:nul));
        const actual=invoke(f.context,"UTF8ToString(__ptr,__len)",offset,length);
        assert.equal(actual,expected,"seed "+SEED+" case "+caseIndex+" offset "+offset+" len "+length);
    }
    console.info("UTF8 property corpus",JSON.stringify({
        seed:SEED,cases:1500,wallMs:Math.round(performance.now()-start),
        rssBytes:process.memoryUsage().rss
    }));
});
test("deterministic typed view oracle rejects all unsafe memory ranges",()=>{
    const random=generator(SEED^0x13579bdf);
    const f=fixture();
    const types=[["Uint8Array",1],["Int16Array",2],["Uint32Array",4],["Float32Array",4]];
    const start=performance.now();
    for(let caseIndex=0;caseIndex<2500;caseIndex++){
        const [type,width]=types[random(types.length)];
        const ptr=random(310)-20;
        const count=random(290)-10;
        const valid=Number.isSafeInteger(ptr)&&Number.isSafeInteger(count)&&
            ptr>=0&&count>=0&&ptr<=256&&ptr%width===0&&
            count<=Math.floor((256-ptr)/width);
        if(valid){
            const view=invoke(f.context,"getArray(__ptr,"+type+",__len)",ptr,count);
            assert.equal(view.length,count);
            assert.equal(view.byteOffset,ptr);
        }else{
            assert.throws(
                ()=>invoke(f.context,"getArray(__ptr,"+type+",__len)",ptr,count),
                /Invalid WASM typed-array memory range/,
                "seed "+SEED+" case "+caseIndex
            );
        }
    }
    console.info("Typed view property corpus",JSON.stringify({
        seed:SEED^0x13579bdf,cases:2500,
        wallMs:Math.round(performance.now()-start),
        rssBytes:process.memoryUsage().rss
    }));
});
