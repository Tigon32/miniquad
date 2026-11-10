#!/usr/bin/env node
// Compare two real release WASM builds, never an inferred optimizer speedup.
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {gzipSync,brotliCompressSync,constants} from "node:zlib";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
function measure(name,path){
    const bytes=readFileSync(resolve(root,path));
    return {name,path,sha256:createHash("sha256").update(bytes).digest("hex"),
      rawBytes:bytes.byteLength,
      gzipBytes:gzipSync(bytes,{level:9}).byteLength,
      brotliBytes:brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).byteLength};
}
const names=["quad","offscreen"];
const builds=names.map(name=>{
    const baseline=measure(name,"target/wasm32-unknown-unknown/release/examples/"+name+".wasm");
    const candidate=measure(name,"target/experiment/wasm32-unknown-unknown/release/examples/"+name+".wasm");
    const changes=Object.fromEntries(["rawBytes","gzipBytes","brotliBytes"].map(k=>[k,{
      bytes:candidate[k]-baseline[k],
      percent:Number(((candidate[k]-baseline[k])*100/baseline[k]).toFixed(3))
    }]));
    return {name,baseline,candidate,delta:changes};
});
const experiment=process.env.MINIQUAD_EXPERIMENT_KIND||"rust-oz";
if(!["rust-oz","binaryen-oz"].includes(experiment)){
  throw new Error("Unknown WASM experiment: "+experiment);
}
const report={
  sourceHead:process.env.GITHUB_HEAD_SHA||process.env.GITHUB_SHA||"local",
  baseline:"cargo build --release --target wasm32-unknown-unknown",
  experiment,
  candidate:experiment==="binaryen-oz"
    ?"Pinned Binaryen wasm-opt -Oz applied to release WASM fixture"
    :'RUSTFLAGS="-C opt-level=z" CARGO_TARGET_DIR=target/experiment cargo build --release --target wasm32-unknown-unknown',
  rustc:process.env.EXPERIMENT_RUSTC_VERSION||"see workflow log",
  runner:process.env.RUNNER_OS||process.platform,
  compression:"gzip 9; Brotli 11",
  measurements:builds,
  limitations:"Same source, different codegen option, one CI run. Does not establish improved frame rate or memory use. Runtime acceptance tests must use the candidate binary before promotion."
};
const file=resolve(root,"test-results/rust-wasm-optlevel-comparison.json");
mkdirSync(dirname(file),{recursive:true});
writeFileSync(file,JSON.stringify(report,null,2)+"\n");
console.log("Rust WASM opt-level comparison",JSON.stringify(report));
