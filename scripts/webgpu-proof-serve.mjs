#!/usr/bin/env node
// Static server for the WebGPU proof candidates (docs/webgpu-proof-contract.md, section 8).
// It serves /<candidate>/ from experiments/webgpu-<candidate>/dist/ on 127.0.0.1 only.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const DEFAULT_PORTS = Object.freeze({manual: 4294, wgpu: 4295});
export const FORBIDDEN_PORTS = Object.freeze([4290, 4292, 4230, 4231]);
export const CANDIDATES = Object.freeze(["manual", "wgpu"]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const types = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".wasm", "application/wasm"],
    [".json", "application/json"],
    [".wgsl", "text/plain; charset=utf-8"],
    [".map", "application/json"],
]);

export function defaultDistFolders(rootDir = root) {
    return Object.fromEntries(CANDIDATES.map(name =>
        [name, resolve(rootDir, "experiments", "webgpu-" + name, "dist")]));
}

export function checkPort(port) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port: " + port);
    if (FORBIDDEN_PORTS.includes(port)) throw new Error("Port is reserved for other work: " + port);
    return port;
}

// Map a request path to a file. Return null for a path outside a candidate folder.
export function resolveAsset(pathname, folders) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes("\0")) return null;
    const match = /^\/([a-z]+)(\/.*)?$/u.exec(decoded);
    if (!match || !Object.hasOwn(folders, match[1])) return null;
    const folder = folders[match[1]];
    let rest = match[2] ?? "/";
    if (rest.endsWith("/")) rest += "index.html";
    const file = resolve(folder, "." + rest);
    if (!file.startsWith(folder + sep)) return null;
    return file;
}

export function createProofServer({folders = defaultDistFolders()} = {}) {
    return createServer(async (request, response) => {
        const pathname = new URL(request.url, "http://" + HOST).pathname;
        if (pathname === "/health") {
            response.writeHead(200, {"content-type": "text/plain", "cache-control": "no-store"});
            response.end("ok");
            return;
        }
        const file = resolveAsset(pathname, folders);
        if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
            response.writeHead(404, {"content-type": "text/plain"});
            response.end("Not found");
            return;
        }
        try {
            if (!(await stat(file)).isFile()) throw new Error("not a file");
            const data = await readFile(file);
            response.writeHead(200, {
                "content-type": types.get(extname(file)) ?? "application/octet-stream",
                "content-length": data.byteLength,
                "cache-control": "no-store",
            });
            response.end(request.method === "HEAD" ? undefined : data);
        } catch {
            response.writeHead(404, {"content-type": "text/plain"});
            response.end("Not found");
        }
    });
}

export function listen(server, port) {
    checkPort(port);
    return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
            server.off("error", reject);
            resolveListen(server.address().port);
        });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const index = process.argv.indexOf("--port");
    const port = index > 0 ? Number(process.argv[index + 1]) : DEFAULT_PORTS.manual;
    const server = createProofServer();
    listen(server, port).then(actual =>
        console.log("WebGPU proof server at http://" + HOST + ":" + actual + "/{manual,wgpu}/"),
    error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
