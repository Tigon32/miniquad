import { test, expect } from "@playwright/test";

test("real canvas pointer buttons reach compiled WASM with ABI button mapping", async ({page}) => {
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.goto("/",{waitUntil:"load"});
  await page.waitForFunction(()=>typeof wasm_exports === "object" &&
    typeof wasm_exports.mouse_down === "function" &&
    typeof document.querySelector("#glcanvas")?.onmousedown === "function");

  await page.evaluate(()=>{
    window.__buttonTransitions=[];
    const original=wasm_exports;
    wasm_exports={
      ...original,
      mouse_down(x,y,button) {
        window.__buttonTransitions.push({type:"down",button,x,y});
        return original.mouse_down(x,y,button);
      },
      mouse_up(x,y,button) {
        window.__buttonTransitions.push({type:"up",button,x,y});
        return original.mouse_up(x,y,button);
      }
    };
  });
  const canvas=page.locator("#glcanvas");
  await canvas.click({button:"left"});
  await canvas.click({button:"right"});
  const events=await page.evaluate(()=>window.__buttonTransitions);
  expect(events.map(event=>({type:event.type,button:event.button}))).toEqual([
    {type:"down",button:0},{type:"up",button:0},
    {type:"down",button:1},{type:"up",button:1}
  ]);
  for(const event of events) {
    expect(event.x).toBeGreaterThanOrEqual(0);
    expect(event.y).toBeGreaterThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test("clipboard copy, cut and paste do not modify an unrelated focused field", async ({page}) => {
  await page.goto("/",{waitUntil:"load"});
  await page.waitForFunction(()=>typeof wasm_exports === "object" &&
    typeof wasm_exports.on_clipboard_paste === "function" &&
    typeof document.querySelector("#glcanvas")?.onkeydown === "function");

  const state=await page.evaluate(()=>{
    const canvas=document.querySelector("#glcanvas");
    const input=document.createElement("input");
    input.type="text";
    input.value="private field";
    document.body.appendChild(input);
    const original=wasm_exports;
    let pasteCalls=0;
    wasm_exports={
      ...original,
      on_clipboard_paste(ptr,len){
        pasteCalls++;
        return original.on_clipboard_paste(ptr,len);
      }
    };
    clipboard="canvas text";
    const writes=[];
    const makeEvent=(type)=> {
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(event,"clipboardData",{
        value:{
          getData(mime){
            if(mime!=="text/plain") throw Error("Wrong MIME "+mime);
            return "should not paste";
          },
          setData(mime,value){writes.push({type,mime,value});}
        }
      });
      return event;
    };
    input.focus();
    const otherCopy=makeEvent("copy"),otherCut=makeEvent("cut"),otherPaste=makeEvent("paste");
    window.dispatchEvent(otherCopy);
    window.dispatchEvent(otherCut);
    window.dispatchEvent(otherPaste);
    const foreign={
      prevented:[otherCopy.defaultPrevented,otherCut.defaultPrevented,otherPaste.defaultPrevented],
      pasteCalls,writes:writes.length,text:input.value
    };
    canvas.focus();
    const canvasCopy=makeEvent("copy"),canvasPaste=makeEvent("paste");
    window.dispatchEvent(canvasCopy);
    window.dispatchEvent(canvasPaste);
    return {
      foreign,
      own:{
        copied:canvasCopy.defaultPrevented,
        pasted:canvasPaste.defaultPrevented,
        pasteCalls,writes
      }
    };
  });

  expect(state.foreign).toEqual({
    prevented:[false,false,false],pasteCalls:0,writes:0,text:"private field"
  });
  expect(state.own.copied).toBe(true);
  expect(state.own.pasted).toBe(true);
  expect(state.own.pasteCalls).toBe(1);
  expect(state.own.writes).toEqual([{
    type:"copy",mime:"text/plain",value:"canvas text"
  }]);
});
