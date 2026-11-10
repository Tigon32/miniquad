import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("compiled WASM renders visible pixels through the checked-in JS bridge",async({page},testInfo)=>{
  const failures=[];
  const requested=new Set();
  const browserMessages=[];
  page.on("console",message=>{
    if (browserMessages.length < 25) browserMessages.push(message.type()+": "+message.text());
  });
  page.on("dialog",async dialog=>{
    failures.push("dialog: "+dialog.message());
    await dialog.dismiss();
  });
  page.on("console",message=>{
    if (message.type()==="error") failures.push("console: "+message.text());
  });
  page.on("pageerror",error=>failures.push("page: "+error.message));
  page.on("response",response=>{
    if (response.status()>=400) failures.push("HTTP "+response.status()+": "+response.url());
    if (response.url().endsWith("/quad.wasm")) requested.add(response.headers()["content-type"]);
  });

  await page.addInitScript(()=>{
    window.__miniquadDrawCount=0;
    window.__miniquadRAFCount=0;
    const originalRAF=window.requestAnimationFrame;
    window.requestAnimationFrame=function(callback){
      return originalRAF.call(this,(timestamp)=>{
        window.__miniquadRAFCount++;
        return callback(timestamp);
      });
    };
    const instrument=klass=>{
      if (!klass) return;
      for(const name of ["drawElements","drawArrays","drawElementsInstanced","drawArraysInstanced"]){
        const original=klass.prototype[name];
        if(typeof original!=="function") continue;
        klass.prototype[name]=function(...args){
          window.__miniquadDrawCount++;
          return original.apply(this,args);
        };
      }
    };
    instrument(window.WebGLRenderingContext);
    instrument(window.WebGL2RenderingContext);
  });

  await page.goto("/",{waitUntil:"load"});
  await expect(page.locator("#glcanvas")).toBeVisible();
  try {
    // WebGL1 ANGLE extension functions can bypass WebGL prototype wrappers.
    // A scheduled WASM frame and actual canvas pixels are the required evidence.
    await page.waitForFunction(()=>window.__miniquadRAFCount>3,null,{timeout:10000});
  } catch (error) {
    const state=await page.evaluate(()=>({
      drawCalls:window.__miniquadDrawCount,
      animationCallbacks:window.__miniquadRAFCount,
      wasmExports:typeof wasm_exports,
      frameExport:typeof wasm_exports === "object" ? typeof wasm_exports.frame : "missing",
      wasmMemory:typeof wasm_memory,
      glContext:typeof gl === "undefined" ? "missing" : gl===null ? "null" : "available",
      visibility:document.visibilityState,
      blockingEventLoop:window.blocking_event_loop,
      canvasWidth:document.querySelector("#glcanvas")?.width,
      canvasHeight:document.querySelector("#glcanvas")?.height
    }));
    throw new Error("No WASM animation frames. "+JSON.stringify({state,failures,browserMessages,wasmResponses:[...requested],timeout:error.message}));
  }
  await page.waitForTimeout(300);

  const sample=PNG.sync.read(await page.locator("#glcanvas").screenshot());
  let colored=0;
  for(let i=0;i<sample.data.length;i+=4){
    const [r,g,b,a]=sample.data.subarray(i,i+4);
    if(a>0 && (r>24 || g>24 || b>24)) colored++;
  }
  expect(colored,"The WASM demo must draw non-black pixels").toBeGreaterThan(50);
  expect([...requested]).toContain("application/wasm");
  expect(failures,"Browser console, JS, and HTTP errors").toEqual([]);
  await testInfo.attach("browser-smoke.json",{body:JSON.stringify({
    browser:testInfo.project.name,
    drawCalls:await page.evaluate(()=>window.__miniquadDrawCount),
    nonBlackPixels:colored,
    imageSize:{width:sample.width,height:sample.height}
  },null,2),contentType:"application/json"});
});
