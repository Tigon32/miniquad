import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(directory, "../..");
const assets = new Map([
  ["/", ["experiments/webgl2-comparison/index.html", "text/html; charset=utf-8"]],
  ["/plain.mjs", ["experiments/webgl2-comparison/plain.mjs", "text/javascript; charset=utf-8"]],
  ["/fixture.json", ["experiments/webgl2-comparison/fixture.json", "application/json"]],
  ["/js/gl.js", ["js/gl.js", "text/javascript; charset=utf-8"]],
  ["/comparison.wasm", ["target/wasm32-unknown-unknown/release/webgl2-comparison.wasm", "application/wasm"]],
]);
const host = "127.0.0.1";
const port = 4174;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://${host}`).pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("ok");
    return;
  }
  const asset = assets.get(pathname);
  if (!asset || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
    return;
  }
  try {
    const data = await readFile(resolve(root, asset[0]));
    response.writeHead(200, {
      "content-type": asset[1],
      "content-length": data.byteLength,
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch (error) {
    console.error(`Cannot serve ${pathname}: ${error.message}`);
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("Comparison asset is missing");
  }
});

server.listen(port, host, () => console.log(`Comparison fixture at http://${host}:${port}`));
