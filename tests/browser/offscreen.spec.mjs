import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("Miniquad renders an offscreen pass and presents its texture", async ({page}, testInfo) => {
  const errors=[];
  const wasmResponses=[];
  page.on("pageerror", error=>errors.push("page: "+error.message));
  page.on("console", message=>{
    if(message.type()==="error") errors.push("console: "+message.text());
  });
  page.on("response", response=>{
    if(response.url().endsWith("/offscreen.wasm")) {
      wasmResponses.push({status:response.status(),type:response.headers()["content-type"]});
    }
  });
  await page.addInitScript(()=>{
    window.__offscreenBindings=0;
    window.__onscreenBindings=0;
    for(const klass of [window.WebGLRenderingContext,window.WebGL2RenderingContext]) {
      if(!klass?.prototype?.bindFramebuffer) continue;
      const original=klass.prototype.bindFramebuffer;
      klass.prototype.bindFramebuffer=function(target, framebuffer) {
        if(framebuffer) window.__offscreenBindings++;
        else window.__onscreenBindings++;
        return original.call(this,target,framebuffer);
      };
    }
  });
  await page.goto("/offscreen", {waitUntil:"load"});
  await page.waitForFunction(()=>window.__offscreenBindings>2 &&
    window.__onscreenBindings>2, null,{timeout:15000});

  const png=PNG.sync.read(await page.locator("#glcanvas").screenshot());
  let nonBlack=0;
  for(let i=0;i<png.data.length;i+=4) {
    if(png.data[i+3]>0 && (png.data[i]>24||png.data[i+1]>24||png.data[i+2]>24)) nonBlack++;
  }
  expect(nonBlack, "Offscreen example must present non-black pixels").toBeGreaterThan(50);
  expect(wasmResponses).toContainEqual({status:200,type:"application/wasm"});
  expect(errors).toEqual([]);
  await testInfo.attach("offscreen-acceptance.json",{
    body:JSON.stringify({browser:testInfo.project.name,offscreenBindings:await page.evaluate(()=>window.__offscreenBindings),
      onscreenBindings:await page.evaluate(()=>window.__onscreenBindings),nonBlackPixels:nonBlack},null,2),
    contentType:"application/json"
  });
});
