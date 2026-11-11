// Private server for issue #131's offline hex browser harness.
// Port 4290 only (explicitly not 4173/4174, 4230/4231, or 4280, which
// belong to other agents' concurrent work on this shared machine).
// Serves only the files this harness needs: the hex-offline page, the
// gl.js loader it depends on, and the two WASM variants built by
// build-fixtures.mjs (WebGL1 default, WebGL2 feature).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

const files = new Map([
    ["/", { file: "tests/browser/hex-offline.html", type: "text/html; charset=utf-8" }],
    ["/hex-offline", { file: "tests/browser/hex-offline.html", type: "text/html; charset=utf-8" }],
    ["/js/gl.js", { file: "js/gl.js", type: "text/javascript; charset=utf-8" }],
    [
        "/offline_hex_webgl1.wasm",
        { file: "companions/voxel/target-webgl1/wasm32-unknown-unknown/release/examples/offline_hex.wasm", type: "application/wasm" }
    ],
    [
        "/offline_hex_webgl2.wasm",
        { file: "companions/voxel/target-webgl2/wasm32-unknown-unknown/release/examples/offline_hex.wasm", type: "application/wasm" }
    ]
]);

const host = "127.0.0.1";
const port = 4290;

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
        const data = await readFile(resolve(repoRoot, asset.file));
        response.writeHead(200, {
            "content-type": asset.type,
            "content-length": data.byteLength,
            "cache-control": "no-store"
        });
        response.end(data);
    } catch (error) {
        console.error("hex-browser fixture server cannot serve", pathname, error.message);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Asset missing: run node experiments/hex-browser/build-fixtures.mjs first");
    }
});

server.listen(port, host, () => console.log("Private hex browser fixture at http://" + host + ":" + port));
