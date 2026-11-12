// Private fixture server for the 2D hex board browser tests
// (`docs/hex-2d-contract.md` section 3.1/4.1, issue #134). Port 4292
// only, reserved for this worker; see the session brief for the other
// workers' ports.
//
// This server is read-only toward the rest of the repository: it only
// serves already-committed, parent-owned `js/` files and this crate's
// own build output under `experiments/hex-2d-browser/build/` (built by
// `build.mjs` in this directory, ignored by git).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const files = new Map([
  ["/", { file: "tests/browser/hex-2d.html", type: "text/html; charset=utf-8" }],
  ["/js/gl.js", { file: "js/gl.js", type: "text/javascript; charset=utf-8" }],
  ["/js/miniquad.mjs", { file: "js/miniquad.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/runtime.html", { file: "js/runtime.html", type: "text/html; charset=utf-8" }],
  ["/js/runtime.mjs", { file: "js/runtime.mjs", type: "text/javascript; charset=utf-8" }],
  ["/js/host-preferences.mjs", { file: "js/host-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  ["/hex_board_webgl1.wasm", { file: "experiments/hex-2d-browser/build/hex_board_webgl1.wasm", type: "application/wasm" }],
  ["/hex_board_webgl2.wasm", { file: "experiments/hex-2d-browser/build/hex_board_webgl2.wasm", type: "application/wasm" }]
]);
const host = "127.0.0.1";
const port = 4292;
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
      "cache-control": "no-store"
    });
    response.end(data);
  } catch (error) {
    console.error("Cannot serve", pathname, error.message);
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("Asset missing");
  }
});
server.listen(port, host, () => console.log("hex-2d browser fixture at http://" + host + ":" + port));
