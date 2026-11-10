import { test, expect } from "@playwright/test";

test("WASM ABI v3 rejects forged, repeated and mismatched ownership transfers", async ({page}) => {
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.goto("/", {waitUntil:"load"});
  await page.waitForFunction(()=>typeof wasm_exports === "object" &&
    typeof wasm_exports.allocate_transfer_vec_u8 === "function" &&
    typeof wasm_exports.on_clipboard_paste === "function");

  const result = await page.evaluate(()=>{
    const wasm=wasm_exports;
    const ptr=wasm.allocate_transfer_vec_u8(4);
    if(ptr<=0) throw Error("No transfer allocation");
    new Uint8Array(wasm_memory.buffer,ptr,4).set([84,101,115,116]);
    wasm.on_clipboard_paste(ptr,4);
    // A second transfer of the same pointer is rejected, not reconstructed
    // from arbitrary Vec metadata or double-freed.
    wasm.on_clipboard_paste(ptr,4);
    wasm.discard_transfer_vec_u8(ptr);
    wasm.on_clipboard_paste(42,999);
    wasm.on_file_dropped(42,999,99,123);

    const bad=wasm.allocate_transfer_vec_u8(3);
    if(bad<=0) throw Error("No second allocation");
    wasm.on_clipboard_paste(bad,4);
    wasm.discard_transfer_vec_u8(bad);
    const oversize=wasm.allocate_transfer_vec_u8(64*1024*1024+1);
    const next=wasm.allocate_transfer_vec_u8(2);
    if(next>0) wasm.discard_transfer_vec_u8(next);
    return {ptr,bad,oversize,next,abi:wasm.crate_version()};
  });
  expect(result.abi).toBe(3);
  expect(result.oversize).toBe(0);
  expect(result.next).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
