#!/usr/bin/env node
// Validate only the Mermaid subset used in the two checked-in source diagrams.
// This is a constrained syntax check, not a semantic review of source edges.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const allowedFiles=new Map([
  ["docs/architecture/components.mmd","flowchart LR"],
  ["docs/architecture/lifecycle.mmd","sequenceDiagram"]
]);

export function checkDiagram(text,kind){
  const lines=text.split(/\r?\n/u).map(x=>x.trim()).filter(Boolean);
  const errors=[];
  if(lines[0]!==kind) errors.push("Invalid diagram declaration: "+(lines[0]||"<empty>"));
  if(kind.startsWith("flowchart")){
    const node=/^[A-Za-z][\w]*(?:\["[^"]*"\])?$/u;
    const edge=/^(?:[A-Za-z][\w]*(?:\["[^"]*"\])?)\s+(?:-->|-\.->)(?:\|"[^"]*"\|)?\s+(?:[A-Za-z][\w]*(?:\["[^"]*"\])?)$/u;
    for(const line of lines.slice(1)){
      if(!edge.test(line)&&!node.test(line))errors.push("Unsupported flowchart syntax: "+line);
    }
  }else if(kind==="sequenceDiagram"){
    const participant=/^participant\s+[A-Za-z][\w]*\s+as\s+.+$/u;
    const message=/^[A-Za-z][\w]*\s*(?:->>|-->>)[A-Za-z][\w]*:\s*.+$/u;
    const control=/^(?:alt|else|opt)\s+.+$/u;
    let depth=0;
    for(const line of lines.slice(1)){
      if(participant.test(line)||message.test(line))continue;
      if(control.test(line)){if(!line.startsWith("else "))depth++;continue;}
      if(line==="end"){depth--;if(depth<0)errors.push("Unmatched end");continue;}
      errors.push("Unsupported sequence syntax: "+line);
    }
    if(depth!==0)errors.push("Unbalanced sequence conditions");
  }
  return errors;
}
export function audit(){
  const errors=[];
  for(const [name,kind] of allowedFiles){
    const text=readFileSync(resolve(root,name),"utf8");
    errors.push(...checkDiagram(text,kind).map(e=>name+": "+e));
  }
  return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const errors=audit();
  errors.forEach(error=>console.error(error));
  if(errors.length)process.exitCode=1;
  else console.log("Architecture Mermaid subset syntax passed for two diagrams.");
}
