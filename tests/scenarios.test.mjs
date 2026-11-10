import test from "node:test";
import assert from "node:assert/strict";
import {audit,checkCatalog} from "../scripts/check-scenarios.mjs";

test("behavior scenarios link to runnable test titles",()=>{
  assert.deepEqual(audit(),[]);
});
test("pending or unlinked scenarios are never counted as passed",()=>{
  const catalog={scenarios:[{id:"LOAD-001",group:"loader",given:"g",when:"w",then:"t",
    testFile:"tests/browser/bad.spec.mjs",testTitle:"not-a-test",mode:"browser"}]};
  const failures=checkCatalog(catalog,()=> 'test.skip("not-a-test",()=>{});');
  assert.match(failures.join(" "),/No runnable test title/);
  assert.match(failures.join(" "),/Missing behavior family/);
});
