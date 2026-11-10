#!/usr/bin/env node
import {readFileSync,existsSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export function checkCatalog(catalog,read=path=>readFileSync(resolve(root,path),"utf8")){
  const errors=[];
  const ids=new Set();
  const groups=new Set();
  for(const scenario of catalog.scenarios||[]){
    if(!/^(?:LOAD|INPUT|TRANSFER|GPU|RESIL)-\d{3}$/u.test(scenario.id||""))
      errors.push("Invalid scenario ID: "+scenario.id);
    if(ids.has(scenario.id))errors.push("Duplicate scenario: "+scenario.id);
    ids.add(scenario.id);
    groups.add(scenario.group);
    for(const field of ["given","when","then","testFile","testTitle"])
      if(typeof scenario[field]!=="string"||!scenario[field].trim())
        errors.push("Missing "+field+" in "+scenario.id);
    if(typeof scenario.testFile!=="string"||!/^tests\/(?:browser\/)?[\w.-]+\.(?:mjs|cjs)$/u.test(scenario.testFile)){
      errors.push("Unsupported test path in "+scenario.id);
      continue;
    }
    let source;
    try{source=read(scenario.testFile);}catch{errors.push("Missing test file "+scenario.testFile);continue;}
    // All mapped titles must be literal, executable test() definitions,
    // not comments, skip/todo or a documentation-only claim.
    const title=scenario.testTitle;
    const names=[...source.matchAll(/^\s*test\s*\(\s*["']([^"'\n]+)["']/gmu)].map(x=>x[1]);
    if(!names.includes(title))errors.push("No runnable test title "+scenario.id+": "+title);
    if(scenario.mode!==(scenario.testFile.startsWith("tests/browser/")?"browser":"node"))
      errors.push("Incorrect execution lane: "+scenario.id);
  }
  for(const group of ["loader","input","unicode","gpu","resilience"])
    if(!groups.has(group))errors.push("Missing behavior family: "+group);
  return errors;
}
export function audit(){
  const filename=resolve(root,"features/scenarios.json");
  if(!existsSync(filename))return ["Missing scenario catalog"];
  const catalog=JSON.parse(readFileSync(filename,"utf8"));
  return checkCatalog(catalog);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const errors=audit();
  errors.forEach(x=>console.error(x));
  if(errors.length)process.exitCode=1;
  else console.log("BDD scenario titles and execution lanes passed.");
}
