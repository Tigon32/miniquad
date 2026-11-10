import { test, expect } from "@playwright/test";

const requiredExports = [
  "memory", "main", "crate_version", "allocate_transfer_vec_u8",
  "discard_transfer_vec_u8", "on_clipboard_paste",
  "on_files_dropped_start", "on_file_dropped", "on_files_dropped_finish",
  "frame", "key_down", "key_up", "key_press", "mouse_down", "mouse_up",
  "mouse_move", "raw_mouse_move", "mouse_wheel", "resize", "touch", "focus"
];

test("compiled WASM imports and exports match the checked-in ABI v3 bridge", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/", { waitUntil: "load" });
  const contract = await page.evaluate(async required => {
    const response = await fetch("/quad.wasm");
    if (!response.ok) throw new Error("Missing compiled WASM contract fixture");
    const wasm = await WebAssembly.compile(await response.arrayBuffer());
    const exports = WebAssembly.Module.exports(wasm);
    const imports = WebAssembly.Module.imports(wasm);
    const missing = imports.filter(spec => {
      const scope = importObject[spec.module];
      return scope == null || scope[spec.name] == null;
    });
    return {
      missing,
      imports,
      exports,
      missingExports: required.filter(name => !exports.some(item => item.name === name)),
      jsAbi: version,
      rustAbi: wasm_exports.crate_version(),
      startupFrame: typeof wasm_exports.frame === "function",
      started: typeof document.querySelector("#glcanvas")?.onkeydown === "function"
    };
  }, requiredExports);
  expect(contract.missing, "All compiled imports must exist in the JS bridge").toEqual([]);
  expect(contract.missingExports, "Required ABI v3 exports must exist in compiled WASM").toEqual([]);
  expect(contract.jsAbi).toBe(3);
  expect(contract.rustAbi).toBe(3);
  expect(contract.startupFrame).toBe(true);
  expect(contract.started).toBe(true);
  expect(contract.imports.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await testInfo.attach("abi-v3-contract.json", {
    contentType: "application/json",
    body: JSON.stringify({ imports: contract.imports, exports: contract.exports, jsAbi: contract.jsAbi }, null, 2)
  });
});
