import test from "node:test";
import assert from "node:assert/strict";
import { audit, checkDiagram } from "../scripts/check-diagrams.mjs";

test("architecture diagrams follow the validated Mermaid syntax subset",()=>{
  assert.deepEqual(audit(),[]);
});
test("unmatched sequence conditions are rejected",()=>{
  assert.match(checkDiagram("sequenceDiagram\nalt case\nA->>B: request","sequenceDiagram").join(" " ),/Unbalanced/);
});
test("unknown Mermaid expressions are not accepted by the limited checker",()=>{
  assert.match(checkDiagram("flowchart LR\nA ~~ B","flowchart LR").join(" " ),/Unsupported/);
});
