import test from "node:test";
import assert from "node:assert/strict";
import {
    validateParameters,
    parseCssColor,
    parseHostURLState,
    readPalette,
    createHostPreferences
} from "../js/host-preferences.mjs";

// --- validateParameters -----------------------------------------------

test("validateParameters accepts speed within bounds",()=>{
    const {value,errors}=validateParameters({speed:1.5});
    assert.deepEqual(value,{speed:1.5});
    assert.deepEqual(errors,[]);
});

test("validateParameters accepts the inclusive speed bounds",()=>{
    assert.deepEqual(validateParameters({speed:0}).value,{speed:0});
    assert.deepEqual(validateParameters({speed:2}).value,{speed:2});
});

test("validateParameters rejects an out-of-range speed with no fallback",()=>{
    const {value,errors}=validateParameters({speed:2.0001});
    assert.deepEqual(value,{});
    assert.equal(errors.length,1);
    assert.equal(errors[0].key,"speed");
});

test("validateParameters rejects non-finite speed",()=>{
    const {value,errors}=validateParameters({speed:Number.POSITIVE_INFINITY});
    assert.deepEqual(value,{});
    assert.equal(errors[0].key,"speed");
});

test("validateParameters accepts a valid foreground/background pair",()=>{
    const {value,errors}=validateParameters({foreground:[0,0,0,1],background:[1,1,1,1]});
    assert.deepEqual(value,{foreground:[0,0,0,1],background:[1,1,1,1]});
    assert.deepEqual(errors,[]);
});

test("validateParameters rejects a sparse color array hole, not a silently coerced NaN/zero",()=>{
    // eslint-disable-next-line no-sparse-arrays
    const sparse=[0,,0,1];
    assert.equal(sparse.length,4);
    assert.equal(1 in sparse,false);
    const {value,errors}=validateParameters({foreground:sparse});
    assert.equal(value.foreground,undefined);
    assert.equal(errors.length,1);
    assert.equal(errors[0].key,"foreground");
    assert.match(errors[0].message,/foreground\[1\]/);
});

test("validateParameters rejects a color array with the wrong length",()=>{
    const {value,errors}=validateParameters({foreground:[0,0,0]});
    assert.equal(value.foreground,undefined);
    assert.equal(errors[0].key,"foreground");
});

test("validateParameters rejects a color component outside [0,1]",()=>{
    const {value,errors}=validateParameters({background:[0,0,0,1.5]});
    assert.equal(value.background,undefined);
    assert.equal(errors[0].key,"background");
});

test("validateParameters reports unknown keys as explicit errors, not silently dropped",()=>{
    const {value,errors}=validateParameters({speed:1,resolution:16});
    assert.deepEqual(value,{speed:1});
    assert.equal(errors.length,1);
    assert.equal(errors[0].key,"resolution");
});

test("validateParameters rejects a non-object payload",()=>{
    const {value,errors}=validateParameters(null);
    assert.deepEqual(value,{});
    assert.equal(errors.length,1);
});

// --- parseCssColor ------------------------------------------------------

test("parseCssColor parses 6-digit hex as opaque",()=>{
    assert.deepEqual(parseCssColor("#000000"),[0,0,0,1]);
    assert.deepEqual(parseCssColor("#ffffff"),[1,1,1,1]);
});

test("parseCssColor parses 3-digit hex shorthand",()=>{
    assert.deepEqual(parseCssColor("#f00"),[1,0,0,1]);
});

test("parseCssColor parses 8-digit hex alpha",()=>{
    const [r,g,b,a]=parseCssColor("#00000080");
    assert.deepEqual([r,g,b],[0,0,0]);
    assert.ok(Math.abs(a-0.502)<0.01);
});

test("parseCssColor parses rgb() and rgba()",()=>{
    assert.deepEqual(parseCssColor("rgb(255, 0, 0)"),[1,0,0,1]);
    const [r,g,b,a]=parseCssColor("rgba(0, 0, 255, 0.5)");
    assert.deepEqual([r,g,b],[0,0,1]);
    assert.equal(a,0.5);
});

test("parseCssColor parses percentage components",()=>{
    assert.deepEqual(parseCssColor("rgb(100%, 0%, 0%)"),[1,0,0,1]);
});

test("parseCssColor parses the transparent keyword",()=>{
    assert.deepEqual(parseCssColor("transparent"),[0,0,0,0]);
});

test("parseCssColor throws on an unsupported color keyword, never guesses",()=>{
    assert.throws(()=>parseCssColor("rebeccapurple"),TypeError);
    assert.throws(()=>parseCssColor("currentcolor"),TypeError);
});

test("parseCssColor throws on malformed input",()=>{
    assert.throws(()=>parseCssColor(""),TypeError);
    assert.throws(()=>parseCssColor("#12"),TypeError);
    assert.throws(()=>parseCssColor("rgb(1,2)"),TypeError);
    assert.throws(()=>parseCssColor(42),TypeError);
});

// --- parseHostURLState ---------------------------------------------------

test("parseHostURLState accepts known, narrow typed values",()=>{
    const {values,errors}=parseHostURLState("scene=aurora&look=dark&view=debug&resolution=16&speed=1.25");
    assert.deepEqual(values,{scene:"aurora",look:"dark",view:"debug",resolution:16,speed:1.25});
    assert.deepEqual(errors,[]);
});

test("parseHostURLState rejects an unknown key, no silent drop",()=>{
    const {values,errors}=parseHostURLState("camera=orbit");
    assert.deepEqual(values,{});
    assert.equal(errors.length,1);
    assert.equal(errors[0].key,"camera");
});

test("parseHostURLState rejects a look value outside the enum",()=>{
    const {values,errors}=parseHostURLState("look=rainbow");
    assert.equal(values.look,undefined);
    assert.equal(errors[0].key,"look");
});

test("parseHostURLState rejects a resolution off the step-4 grid",()=>{
    const {values,errors}=parseHostURLState("resolution=10");
    assert.equal(values.resolution,undefined);
    assert.equal(errors[0].key,"resolution");
});

test("parseHostURLState rejects a resolution outside [8,56]",()=>{
    assert.equal(parseHostURLState("resolution=4").values.resolution,undefined);
    assert.equal(parseHostURLState("resolution=60").values.resolution,undefined);
});

test("parseHostURLState accepts the inclusive resolution bounds",()=>{
    assert.equal(parseHostURLState("resolution=8").values.resolution,8);
    assert.equal(parseHostURLState("resolution=56").values.resolution,56);
});

test("parseHostURLState rejects a speed outside [0,2]",()=>{
    const {values,errors}=parseHostURLState("speed=3");
    assert.equal(values.speed,undefined);
    assert.equal(errors[0].key,"speed");
});

test("parseHostURLState rejects a scene id with disallowed characters",()=>{
    const {values,errors}=parseHostURLState("scene=Not_Valid!");
    assert.equal(values.scene,undefined);
    assert.equal(errors[0].key,"scene");
});

test("parseHostURLState accepts a URLSearchParams instance directly",()=>{
    const params=new URLSearchParams();
    params.set("speed","0.5");
    const {values}=parseHostURLState(params);
    assert.equal(values.speed,0.5);
});

// --- readPalette ----------------------------------------------------------

function fakeElementAndView(properties){
    const view={
        getComputedStyle:()=>({
            getPropertyValue:(name)=>properties[name] ?? ""
        })
    };
    return {element:{},view};
}

test("readPalette reads and validates custom properties",()=>{
    const {element,view}=fakeElementAndView({"--miniquad-foreground":"#ff0000","--miniquad-background":"#000000"});
    const {value,errors}=readPalette(element,view);
    assert.deepEqual(value,{foreground:[1,0,0,1],background:[0,0,0,1]});
    assert.deepEqual(errors,[]);
});

test("readPalette omits an unset property without error",()=>{
    const {element,view}=fakeElementAndView({"--miniquad-foreground":"#ff0000"});
    const {value,errors}=readPalette(element,view);
    assert.deepEqual(value,{foreground:[1,0,0,1]});
    assert.deepEqual(errors,[]);
});

test("readPalette reports an invalid custom property instead of dropping it",()=>{
    const {element,view}=fakeElementAndView({"--miniquad-foreground":"not-a-color"});
    const {value,errors}=readPalette(element,view);
    assert.equal(value.foreground,undefined);
    assert.equal(errors.length,1);
    assert.equal(errors[0].key,"foreground");
});

test("readPalette returns empty results when getComputedStyle is unavailable",()=>{
    const {value,errors}=readPalette({},{});
    assert.deepEqual(value,{});
    assert.deepEqual(errors,[]);
});

// --- createHostPreferences -------------------------------------------------

function fakeMediaList(matches){
    const handlers=new Set();
    return {
        matches,
        addEventListener:(type,handler)=>handlers.add(handler),
        removeEventListener:(type,handler)=>handlers.delete(handler),
        fire(matches){
            this.matches=matches;
            for(const handler of handlers){
                handler({matches});
            }
        }
    };
}

function fakeView(initial={}){
    const lists=new Map();
    const defaults={
        "(prefers-color-scheme: dark)":false,
        "(prefers-reduced-motion: reduce)":false,
        "(forced-colors: active)":false,
        "(prefers-contrast: more)":false,
        "(prefers-contrast: less)":false,
        "(prefers-contrast: custom)":false,
        ...initial
    };
    for(const [condition,matches] of Object.entries(defaults)){
        lists.set(condition,fakeMediaList(matches));
    }
    return {
        matchMedia:(condition)=>lists.get(condition) ?? fakeMediaList(false),
        getComputedStyle:()=>({getPropertyValue:()=>""}),
        lists
    };
}

function fakeApplication(){
    const calls=[];
    return {
        calls,
        supportsParameters:true,
        setParameters(partial){ calls.push(["setParameters",partial]); },
        pause(){ calls.push(["pause"]); },
        resume(){ calls.push(["resume"]); }
    };
}

test("createHostPreferences requires an application handle",()=>{
    assert.throws(()=>createHostPreferences({element:{},application:null}),TypeError);
});

test("createHostPreferences pauses immediately when reduced motion is already active",()=>{
    const view=fakeView({"(prefers-reduced-motion: reduce)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    assert.deepEqual(application.calls,[["pause"]]);
    assert.equal(handle.getState().reducedMotion,true);
    handle.dispose();
});

test("createHostPreferences resumes when reduced motion is not active",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    assert.deepEqual(application.calls,[["resume"]]);
    handle.dispose();
});

test("createHostPreferences reacts to a reduced-motion change event",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    application.calls.length=0;
    view.lists.get("(prefers-reduced-motion: reduce)").fire(true);
    assert.deepEqual(application.calls,[["pause"]]);
    assert.equal(handle.getState().reducedMotion,true);
    handle.dispose();
});

test("createHostPreferences does not repeat the same motion call twice",()=>{
    const view=fakeView({"(prefers-reduced-motion: reduce)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    application.calls.length=0;
    view.lists.get("(prefers-reduced-motion: reduce)").fire(true);
    assert.deepEqual(application.calls,[]);
    handle.dispose();
});

test("setMotionOverride forces paused state regardless of the media query",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    application.calls.length=0;
    handle.setMotionOverride("paused");
    assert.deepEqual(application.calls,[["pause"]]);
    view.lists.get("(prefers-reduced-motion: reduce)").fire(true);
    assert.deepEqual(application.calls,[["pause"]]);
    handle.dispose();
});

test("setMotionOverride('auto') restores media-query-driven behavior",()=>{
    const view=fakeView({"(prefers-reduced-motion: reduce)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    handle.setMotionOverride("running");
    application.calls.length=0;
    handle.setMotionOverride("auto");
    assert.deepEqual(application.calls,[["pause"]]);
    handle.dispose();
});

test("setMotionOverride rejects an unknown mode via onError, no silent fallback",()=>{
    const view=fakeView();
    const application=fakeApplication();
    let reported=null;
    const handle=createHostPreferences({element:{},application,view,onError:(error)=>{reported=error;}});
    handle.setMotionOverride("sleeping");
    assert.ok(reported instanceof Error);
    assert.equal(handle.getState().motionOverride,"auto");
    handle.dispose();
});

test("createHostPreferences applies a valid palette from custom properties",()=>{
    const view=fakeView();
    view.getComputedStyle=()=>({
        getPropertyValue:(name)=>({
            "--miniquad-foreground":"#ff0000",
            "--miniquad-background":"#000000"
        }[name] ?? "")
    });
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    const call=application.calls.find((entry)=>entry[0]==="setParameters");
    assert.deepEqual(call[1],{foreground:[1,0,0,1],background:[0,0,0,1]});
    handle.dispose();
});

test("createHostPreferences reports an invalid custom property through onError",()=>{
    const view=fakeView();
    view.getComputedStyle=()=>({getPropertyValue:(name)=>name==="--miniquad-foreground" ? "not-a-color" : ""});
    const application=fakeApplication();
    const errors=[];
    const handle=createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)});
    assert.ok(errors.length>=1);
    assert.ok(errors[0].message.includes("foreground"));
    handle.dispose();
});

test("createHostPreferences reports an unsupported setParameters command, never swallows it",()=>{
    const view=fakeView();
    view.getComputedStyle=()=>({getPropertyValue:(name)=>name==="--miniquad-foreground" ? "#ff0000" : ""});
    const application={supportsParameters:false,pause(){},resume(){}};
    const errors=[];
    const handle=createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)});
    assert.ok(errors.some((error)=>error.message.includes("does not support setParameters")));
    handle.dispose();
});

test("a runtime throw from application.setParameters() is routed through onError, not propagated",()=>{
    const view=fakeView();
    view.getComputedStyle=()=>({getPropertyValue:(name)=>name==="--miniquad-foreground" ? "#ff0000" : ""});
    const application={
        supportsParameters:true,
        pause(){},
        resume(){},
        setParameters(){ throw new Error("rejected: unsupported combination"); }
    };
    const errors=[];
    assert.doesNotThrow(()=>createHostPreferences({
        element:{},application,view,onError:(error)=>errors.push(error)
    }));
    assert.ok(errors.some((error)=>error.message.includes("application.setParameters() threw")
        && error.message.includes("rejected: unsupported combination")));
});

test("a runtime throw from application.pause() is routed through onError, not propagated",()=>{
    const view=fakeView({"(prefers-reduced-motion: reduce)":true});
    const application={
        supportsParameters:true,
        pause(){ throw new Error("device lost"); },
        resume(){}
    };
    const errors=[];
    assert.doesNotThrow(()=>createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)}));
    assert.ok(errors.some((error)=>error.message.includes("application.pause() threw")
        && error.message.includes("device lost")));
});

test("a runtime throw from application.resume() is routed through onError, not propagated",()=>{
    const view=fakeView();
    const application={
        supportsParameters:true,
        pause(){},
        resume(){ throw new Error("context not ready"); }
    };
    const errors=[];
    assert.doesNotThrow(()=>createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)}));
    assert.ok(errors.some((error)=>error.message.includes("application.resume() threw")
        && error.message.includes("context not ready")));
});

test("a runtime throw reports the original error as cause, without a broad swallow of other errors",()=>{
    const view=fakeView();
    const original=new Error("boom");
    const application={
        supportsParameters:true,
        pause(){},
        resume(){ throw original; }
    };
    const errors=[];
    createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)});
    const reported=errors.find((error)=>error.message.includes("application.resume() threw"));
    assert.equal(reported.cause,original);
});

test("a runtime throw without onError still surfaces (no silent fallback) instead of a false success",()=>{
    const view=fakeView({"(prefers-reduced-motion: reduce)":true});
    const application={
        supportsParameters:true,
        pause(){ throw new Error("boom"); },
        resume(){}
    };
    const originalQueueMicrotask=globalThis.queueMicrotask;
    const deferred=[];
    globalThis.queueMicrotask=(callback)=>deferred.push(callback);
    try {
        // Construction itself must not throw synchronously: the re-throw is
        // deferred to a later microtask so it stays visible instead of
        // being swallowed by this constructor call.
        assert.doesNotThrow(()=>createHostPreferences({element:{},application,view}));
        assert.equal(deferred.length,1);
        assert.throws(()=>deferred[0](),/application\.pause\(\) threw: boom/);
    } finally {
        globalThis.queueMicrotask=originalQueueMicrotask;
    }
});

test("setSpeed validates before forwarding, and reports an out-of-range value",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const errors=[];
    const handle=createHostPreferences({element:{},application,view,onError:(error)=>errors.push(error)});
    application.calls.length=0;
    handle.setSpeed(5);
    assert.deepEqual(application.calls,[]);
    assert.ok(errors.some((error)=>error.message.includes("speed")));
    handle.setSpeed(1);
    assert.deepEqual(application.calls,[["setParameters",{speed:1}]]);
    handle.dispose();
});

test("subscribe receives a snapshot on a preference change and can unsubscribe",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    const seen=[];
    const unsubscribe=handle.subscribe((state)=>seen.push(state));
    view.lists.get("(prefers-color-scheme: dark)").fire(true);
    assert.equal(seen.length,1);
    assert.equal(seen[0].colorScheme,"dark");
    unsubscribe();
    view.lists.get("(prefers-color-scheme: dark)").fire(false);
    assert.equal(seen.length,1);
    handle.dispose();
});

test("a prefers-contrast change recomputes from all three queries instead of sticking to the last positive match",()=>{
    const view=fakeView({"(prefers-contrast: more)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    assert.equal(handle.getState().contrast,"more");
    const seen=[];
    handle.subscribe((state)=>seen.push(state));
    // The system preference changes back to no-preference: the real
    // "(prefers-contrast: more)" query now reports false, matching how a
    // browser actually fires this event.
    view.lists.get("(prefers-contrast: more)").matches=false;
    view.lists.get("(prefers-contrast: more)").fire(false);
    assert.equal(handle.getState().contrast,"no-preference");
    assert.equal(seen.length,1);
    assert.equal(seen[0].contrast,"no-preference");
    handle.dispose();
});

test("a prefers-contrast change from less to custom recomputes the new value",()=>{
    const view=fakeView({"(prefers-contrast: less)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    assert.equal(handle.getState().contrast,"less");
    view.lists.get("(prefers-contrast: less)").matches=false;
    view.lists.get("(prefers-contrast: custom)").matches=true;
    view.lists.get("(prefers-contrast: custom)").fire(true);
    assert.equal(handle.getState().contrast,"custom");
    handle.dispose();
});

test("a prefers-contrast change never calls pause(), resume(), or setParameters()",()=>{
    const view=fakeView({"(prefers-contrast: more)":true});
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    application.calls.length=0;
    view.lists.get("(prefers-contrast: more)").matches=false;
    view.lists.get("(prefers-contrast: more)").fire(false);
    assert.deepEqual(application.calls,[]);
    handle.dispose();
});

test("dispose removes every media listener and further state changes are not observed",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    handle.dispose();
    application.calls.length=0;
    view.lists.get("(prefers-reduced-motion: reduce)").fire(true);
    assert.deepEqual(application.calls,[]);
    assert.equal(handle.getState().reducedMotion,false);
});

test("dispose is idempotent",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    handle.dispose();
    assert.doesNotThrow(()=>handle.dispose());
});

test("methods throw after dispose instead of silently doing nothing",()=>{
    const view=fakeView();
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view});
    handle.dispose();
    assert.throws(()=>handle.setSpeed(1));
    assert.throws(()=>handle.refreshPalette());
    assert.throws(()=>handle.setMotionOverride("paused"));
});

test("createHostPreferences works without a view (non-browser) by skipping media wiring",()=>{
    const application=fakeApplication();
    const handle=createHostPreferences({element:{},application,view:undefined});
    assert.equal(handle.getState().reducedMotion,false);
    handle.dispose();
});
