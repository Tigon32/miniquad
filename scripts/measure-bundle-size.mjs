#!/usr/bin/env node
// Revision-specific build size receipt; this is not a performance SLO gate.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const inputs=[
  "js/gl.js",
  "target/wasm32-unknown-unknown/release/examples/quad.wasm",
  "target/wasm32-unknown-unknown/release/examples/offscreen.wasm"
];
function sizeReceipt(name, bytes) {
  const compressedGzip=gzipSync(bytes,{level:9});
  const compressedBrotli=brotliCompressSync(bytes,{
    params:{[constants.BROTLI_PARAM_QUALITY]:11}
  });
  return {
    name,sha256:createHash("sha256").update(bytes).digest("hex"),
    rawBytes:bytes.length,gzipBytes:compressedGzip.length,
    brotliBytes:compressedBrotli.length
  };
}
const files=inputs.map(name=>sizeReceipt(name,readFileSync(resolve(root,name))));
const output={
  schema:1,
  measuredAt:new Date().toISOString(),
  revision:process.env.GITHUB_HEAD_SHA||process.env.GITHUB_SHA||"local-unidentified",
  runner:process.env.RUNNER_OS||process.platform,
  nodeVersion:process.version,
  compression:{gzipLevel:9,brotliQuality:11},
  assets:files,
  transportNote:"These are deterministic compression calculations, not an HTTP transfer capture. HTTP headers, caching and network timing are not measured."
};
const out=resolve(root,"test-results/build-size-receipt.json");
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(output,null,2)+"\n");
console.log("Build size receipt",JSON.stringify(output));
