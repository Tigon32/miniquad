import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const files = new Map([
  ["/", {file:"tests/browser/smoke.html",type:"text/html; charset=utf-8"}],
  ["/js/gl.js", {file:"js/gl.js",type:"text/javascript; charset=utf-8"}],
  ["/js/miniquad.mjs", {file:"js/miniquad.mjs",type:"text/javascript; charset=utf-8"}],
  ["/js/runtime.html", {file:"js/runtime.html",type:"text/html; charset=utf-8"}],
  ["/js/runtime.mjs", {file:"js/runtime.mjs",type:"text/javascript; charset=utf-8"}],
  ["/js/host-preferences.mjs", {file:"js/host-preferences.mjs",type:"text/javascript; charset=utf-8"}],
  ["/embed", {file:"tests/browser/embed.html",type:"text/html; charset=utf-8"}],
  ["/drawing-qualification", {file:"tests/browser/drawing-qualification.html",type:"text/html; charset=utf-8"}],
  ["/drawing.wasm", {file:"companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm",type:"application/wasm"}],
  ["/drawing-consumer.wasm", {file:"experiments/drawing-comparison/external-consumer/target/wasm32-unknown-unknown/release/examples/consume.wasm",type:"application/wasm"}],
  ["/voxel.wasm", {file:"companions/voxel/target/wasm32-unknown-unknown/release/examples/offline.wasm",type:"application/wasm"}],
  ["/clock-privacy", {file:"tests/browser/clock-privacy.html",type:"text/html; charset=utf-8"}],
  ["/quad.wasm", {file:"target/wasm32-unknown-unknown/release/examples/quad.wasm",type:"application/wasm"}],
  ["/offscreen", {file:"tests/browser/offscreen.html",type:"text/html; charset=utf-8"}],
  ["/offscreen.wasm", {file:"target/wasm32-unknown-unknown/release/examples/offscreen.wasm",type:"application/wasm"}],
  ["/gpu-timer-query-webgl1", {file:"tests/browser/gpu-timer-query-webgl1.html",type:"text/html; charset=utf-8"}],
  ["/gpu-timer-query-webgl2", {file:"tests/browser/gpu-timer-query-webgl2.html",type:"text/html; charset=utf-8"}],
  ["/gpu_timer_query_webgl1.wasm", {file:"target/wasm32-unknown-unknown/release/examples/gpu_timer_query_webgl1.wasm",type:"application/wasm"}],
  ["/gpu_timer_query_webgl2.wasm", {file:"target/wasm32-unknown-unknown/release/examples/gpu_timer_query_webgl2.wasm",type:"application/wasm"}]
]);
const host = "127.0.0.1";
const port = 4173;
const server = createServer(async (request,response) => {
  const pathname = new URL(request.url, "http://"+host).pathname;
  if (pathname === "/health") {
    response.writeHead(200, {"content-type":"text/plain","cache-control":"no-store"});
    response.end("ok");
    return;
  }
  const asset=files.get(pathname);
  if (!asset || request.method !== "GET") {
    response.writeHead(404,{"content-type":"text/plain"});
    response.end("Not found");
    return;
  }
  try {
    const data=await readFile(resolve(root,asset.file));
    response.writeHead(200,{"content-type":asset.type,"content-length":data.byteLength,"cache-control":"no-store"});
    response.end(data);
  } catch (error) {
    console.error("Cannot serve",pathname,error.message);
    response.writeHead(500,{"content-type":"text/plain"});
    response.end("Asset missing");
  }
});
server.listen(port,host,()=>console.log("Browser fixture at http://"+host+":"+port));
