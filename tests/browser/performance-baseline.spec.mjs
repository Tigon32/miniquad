import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

function sourceRevision() {
  const eventPath=process.env.GITHUB_EVENT_PATH;
  if(eventPath) {
    const event=JSON.parse(readFileSync(eventPath,"utf8"));
    if(event.pull_request?.head?.sha)return event.pull_request.head.sha;
  }
  return process.env.GITHUB_HEAD_SHA||process.env.GITHUB_SHA||"local";
}

function percentile(sorted,p) {
  if(!sorted.length)return null;
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
}

test("record browser startup and frame interval baselines without enforcing uncalibrated SLOs",async({page},testInfo)=>{
  await page.addInitScript(()=>{
    window.__browserSLI={
      navigationStart:performance.timeOrigin,
      firstDrawMs:null,
      firstWasmFrameCallbackMs:null,
      animationFrames:[],
      cpuFrameMs:[]
    };
    // Observe the actual GL submission path, not just drawElements.
    // WebGL1 may use ANGLE_instanced_arrays for indexed and array draws.
    function recordDraw() {
      if(window.__browserSLI.firstDrawMs===null) {
        window.__browserSLI.firstDrawMs=performance.now();
      }
    }
    function wrapDraw(target,method) {
      if(typeof target?.[method]!=="function")return;
      const original=target[method];
      target[method]=function(...args){
        recordDraw();
        return original.apply(this,args);
      };
    }
    for(const klass of [window.WebGLRenderingContext,window.WebGL2RenderingContext]) {
      if(!klass?.prototype)continue;
      for(const method of ["drawElements","drawArrays","drawElementsInstanced","drawArraysInstanced"]) {
        wrapDraw(klass.prototype,method);
      }
      const originalGetExtension=klass.prototype.getExtension;
      if(typeof originalGetExtension!=="function")continue;
      const instrumentedExtensions=new WeakSet();
      klass.prototype.getExtension=function(...args){
        const extension=originalGetExtension.apply(this,args);
        if(extension && String(args[0]).toLowerCase()==="angle_instanced_arrays" &&
           !instrumentedExtensions.has(extension)){
          for(const method of ["drawElementsInstancedANGLE","drawArraysInstancedANGLE"]) {
            wrapDraw(extension,method);
          }
          instrumentedExtensions.add(extension);
        }
        return extension;
      };
    }
    const raf=window.requestAnimationFrame;
    window.requestAnimationFrame=function(callback){
      return raf.call(this,timestamp=>{
        if(typeof wasm_exports==="object"&&typeof wasm_exports.frame==="function"){
          if(window.__browserSLI.firstWasmFrameCallbackMs===null){
            window.__browserSLI.firstWasmFrameCallbackMs=performance.now();
          }
          window.__browserSLI.animationFrames.push(timestamp);
        }
        return callback(timestamp);
      });
    };
  });
  await page.goto("/",{waitUntil:"load"});
  await page.waitForFunction(()=>typeof wasm_exports==="object"&&
    typeof wasm_exports.frame==="function"&&
    typeof document.querySelector("#glcanvas")?.onkeydown==="function");
  await page.evaluate(()=>{
    const original=wasm_exports;
    wasm_exports={
      ...original,
      frame(...args){
        const before=performance.now();
        try{return original.frame(...args);}
        finally{window.__browserSLI.cpuFrameMs.push(performance.now()-before);}
      }
    };
  });
  await page.waitForFunction(()=>window.__browserSLI.animationFrames.length>=60 &&
    window.__browserSLI.cpuFrameMs.length>=40,{},{timeout:20000});
  const metrics=await page.evaluate(()=>{
    const sli=window.__browserSLI;
    return {
      firstWebGLDrawSubmissionMs:sli.firstDrawMs,
      firstWasmFrameCallbackMs:sli.firstWasmFrameCallbackMs,
      rafTimestampsMs:sli.animationFrames.slice(0,80),
      cpuFrameMs:sli.cpuFrameMs.slice(0,80),
      navigation:performance.getEntriesByType("navigation").map(n=>({
        durationMs:n.duration,responseEndMs:n.responseEnd,transferBytes:n.transferSize
      }))
    };
  });
  const intervals=metrics.rafTimestampsMs.slice(1).map((n,i)=>n-metrics.rafTimestampsMs[i]);
  const sortedIntervals=[...intervals].sort((a,b)=>a-b);
  const sortedCpu=[...metrics.cpuFrameMs].sort((a,b)=>a-b);
  const receipt={
    schema:1,
    browser:testInfo.project.name,
    testSourceRevision:sourceRevision(),
    samples:{frameIntervals:intervals.length,cpuFrames:metrics.cpuFrameMs.length},
    firstWebGLDrawSubmissionMs:metrics.firstWebGLDrawSubmissionMs,
    firstWasmFrameCallbackMs:metrics.firstWasmFrameCallbackMs,
    frameIntervalMs:{p50:percentile(sortedIntervals,.5),p95:percentile(sortedIntervals,.95),p99:percentile(sortedIntervals,.99)},
    jsToWasmFrameCallMs:{p50:percentile(sortedCpu,.5),p95:percentile(sortedCpu,.95),p99:percentile(sortedCpu,.99)},
    navigation:metrics.navigation,
    limitations:"Warm running browser frame samples. First WASM frame callback is not first visible painted pixel; first GL draw submission may be null when the engine uses extension-backed instanced calls. JS-to-WASM frame call includes CPU GL submission, not GPU completion. Not GPU memory or native device metrics."
  };
  expect(receipt.firstWasmFrameCallbackMs).toBeGreaterThan(0);
  await testInfo.attach("browser-sli-baseline.json",{
    contentType:"application/json",body:JSON.stringify(receipt,null,2)
  });
  console.info("Browser SLI receipt",JSON.stringify(receipt));
});
