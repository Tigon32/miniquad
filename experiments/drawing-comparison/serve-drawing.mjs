#!/usr/bin/env node
// Isolated, session-owned static server for the drawing-companion
// browser qualification (issue #123). Deliberately not
// `tests/browser/serve.mjs` (parent-owned, port 4173): this server
// listens on its own ephemeral-by-convention port (4280) so this
// session's Playwright run never races the parent's, per the task's
// "DO NOT run parent Playwright same ports concurrently" instruction.
//
// Serves the existing, unmodified root JS bridge (`js/gl.js`,
// `js/miniquad.mjs`, `js/runtime.mjs`, `js/runtime.html`,
// `js/host-preferences.mjs`) and the parent's existing
// `tests/browser/embed.html` fixture read-only, exactly as the parent's
// own server does, plus this session's own
// `tests/browser/drawing-qualification.html` and the companion's own
// built `showcase.wasm`. It copies no file content: every entry below
// reads straight from the existing repository path.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = new Map([
  ["/js/gl.js", { file: "js/gl.js", type: "text/javascript; charset=utf-8" }],
  ["/js/miniquad.mjs", { file: "js/miniquad.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/runtime.html", { file: "js/runtime.html", type: "text/html; charset=utf-8" }],
  ["/js/runtime.mjs", { file: "js/runtime.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/host-preferences.mjs", { file: "js/host-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  ["/embed", { file: "tests/browser/embed.html", type: "text/html; charset=utf-8" }],
  ["/qualification", { file: "tests/browser/drawing-qualification.html", type: "text/html; charset=utf-8" }],
  [
    "/drawing.wasm",
    {
      file: "companions/draw/target/wasm32-unknown-unknown/release/examples/showcase.wasm",
      type: "application/wasm",
    },
  ],
  [
    "/consumer.wasm",
    {
      file: "experiments/drawing-comparison/external-consumer/target/wasm32-unknown-unknown/release/examples/consume.wasm",
      type: "application/wasm",
    },
  ],
]);
const host = "127.0.0.1";
const port = Number(process.env.DRAWING_QUALIFICATION_PORT || 4280);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://" + host).pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("ok");
    return;
  }
  const asset = files.get(pathname);
  if (!asset || request.method !== "GET") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
    return;
  }
  try {
    const data = await readFile(resolve(root, asset.file));
    response.writeHead(200, {
      "content-type": asset.type,
      "content-length": data.byteLength,
      "cache-control": "no-store",
    });
    response.end(data);
  } catch (error) {
    console.error("Cannot serve", pathname, error.message);
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("Asset missing: " + error.message);
  }
});
server.listen(port, host, () => console.log("Drawing qualification fixture at http://" + host + ":" + port));
