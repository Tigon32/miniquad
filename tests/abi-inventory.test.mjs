import test from "node:test";
import assert from "node:assert/strict";
import {audit,compareNames} from "../scripts/check-abi-inventory.mjs";

test("every Rust browser import/export is uniquely inventoried",()=>{
  assert.deepEqual(audit(),[]);
});
test("an omitted, unknown or duplicate ABI function fails",()=>{
  assert.deepEqual(compareNames(["alpha","beta"],["alpha","alpha","gamma"],"ABI"),[
    "ABI: undocumented declaration beta",
    "ABI: duplicate inventory entry alpha",
    "ABI: unknown documented function gamma"
  ]);
});
