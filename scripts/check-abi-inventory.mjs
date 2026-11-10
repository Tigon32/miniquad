#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=name=>readFileSync(resolve(root,name),"utf8");
const platform=read("src/native/wasm.rs");
const webgl=read("src/native/wasm/webgl.rs");
const doc=read("docs/abi-v3-function-inventory.md");

export function sourceNames(source, kind) {
  const regex=kind==="export"
    ? /pub extern "C" fn ([A-Za-z_]\w*)\s*\(/gu
    : /pub fn ([A-Za-z_]\w*)\s*\(/gu;
  return [...source.matchAll(regex)].map(x=>x[1]);
}
export function documentedNames(document, section) {
  const start="## "+section+"\n";
  const offset=document.indexOf(start);
  if(offset<0)throw Error("Missing inventory section: "+section);
  const next=document.indexOf("\n## ",offset+start.length);
  const part=document.slice(offset+start.length,next<0?undefined:next);
  return [...part.matchAll(/^\| `([A-Za-z_]\w*)` \|/gmu)].map(x=>x[1]);
}
export function compareNames(actual,listed,group) {
  const errors=[];
  const counts=new Map();
  for(const name of listed)counts.set(name,(counts.get(name)||0)+1);
  const expected=new Set(actual);
  for(const name of expected)if(!counts.has(name))errors.push(group+": undocumented declaration "+name);
  for(const [name,count] of counts){
    if(!expected.has(name))errors.push(group+": unknown documented function "+name);
    if(count!==1)errors.push(group+": duplicate inventory entry "+name);
  }
  return errors;
}
export function audit(){
  return [
    ...compareNames(sourceNames(platform,"import"),documentedNames(doc,"Platform/browser imports"),"platform"),
    ...compareNames(sourceNames(webgl,"import"),documentedNames(doc,"WebGL imports"),"WebGL"),
    ...compareNames(sourceNames(platform,"export"),documentedNames(doc,"Rust exports"),"export")
  ];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const errors=audit();
  errors.forEach(error=>console.error(error));
  if(errors.length)process.exitCode=1;
  else console.log("ABI v3 Rust import and export inventory passed.");
}
