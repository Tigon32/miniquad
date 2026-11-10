#!/usr/bin/env node
// Traversal-safe static file server for the "web" output directory.
// Uses only Node.js builtins; no npm dependencies.
//
// Usage: node scripts/serve.mjs [--port 8080] [--base /subpath]

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_ROOT = resolve(join(PROJECT_ROOT, "web"));

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export function parseArgs(argv) {
  const options = { port: 8080, base: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && argv[i + 1]) {
      options.port = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--base" && argv[i + 1]) {
      let base = argv[i + 1];
      if (!base.startsWith("/")) {
        base = `/${base}`;
      }
      options.base = base.replace(/\/+$/, "");
      i += 1;
    }
  }
  return options;
}

// Resolves a request path against `webRoot` and rejects any path that
// would escape it, including through "..", encoded separators, or
// symlink-adjacent traversal via normalize+resolve comparison.
export function resolveSafePath(requestPath, base, webRoot = WEB_ROOT) {
  let relative = requestPath;
  if (base && relative.startsWith(base)) {
    relative = relative.slice(base.length);
  } else if (base) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(relative.split("?")[0]);
  } catch {
    return null;
  }

  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(join(webRoot, normalized));

  if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) {
    return null;
  }
  return candidate;
}

function sendNotFound(res, requestPath) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    `404 Not Found: ${requestPath}\n` +
      `Expected the generated output under: ${WEB_ROOT}\n` +
      "Run the build script first: node scripts/build.mjs"
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(WEB_ROOT)) {
    console.error(
      `error: missing web output directory: ${WEB_ROOT}\n` +
        "Run the build script first: node scripts/build.mjs"
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const requestPath = req.url || "/";
    let target = resolveSafePath(requestPath, options.base);
    if (target === null) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("400 Bad Request: path escapes the served directory");
      return;
    }

    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, "index.html");
    }

    if (!existsSync(target) || !statSync(target).isFile()) {
      sendNotFound(res, requestPath);
      return;
    }

    const ext = target.slice(target.lastIndexOf("."));
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(target).pipe(res);
  });

  server.listen(options.port, () => {
    const baseLabel = options.base || "/";
    console.log(
      `Serving ${WEB_ROOT} at http://localhost:${options.port}${baseLabel}`
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
