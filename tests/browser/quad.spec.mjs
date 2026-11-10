import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("compiled WASM renders visible pixels through the checked-in JS bridge",async({page},testInfo)=>{
  const failures=[];
  const requested=new Set();
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
    await page.waitForFunction(()=>window.__miniquadDrawCount>0,null,{timeout:10000});
  } catch (error) {
    const state=await page.evaluate(()=>({
      drawCalls:window.__miniquadDrawCount,
      wasmExports:typeof wasm_exports,
      wasmMemory:typeof wasm_memory,
      glContext:typeof gl,
      canvasWidth:document.querySelector("#glcanvas")?.width,
      canvasHeight:document.querySelector("#glcanvas")?.height
    }));
    throw new Error("No WASM draw call. "+JSON.stringify({state,failures,wasmResponses:[...requested],timeout:error.message}));
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
