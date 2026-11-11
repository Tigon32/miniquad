// STE-aligned draft. Full dictionary review not done.
//
// A small, same-origin HTTP gateway for one voxel sync route.
// It forwards POST /vx/v1/sync to the authoritative native voxel server
// at 127.0.0.1:<port>. It does not read, decode, or revalidate the
// VXP1 wire protocol. It moves bytes between the browser and the
// upstream native server, and it enforces size and time bounds.
//
// Upstream contract (owned and tested by the native protocol work):
//   request body:  24-byte LE VXP1 header + payload, <=1048 bytes total
//   response body: 24-byte header + payload, <=16384 bytes payload
//                  (<=16408 bytes total)

import { request as httpRequest } from "node:http";

export const VOXEL_SYNC_PATH = "/vx/v1/sync";
export const DEFAULT_VOXEL_SERVER_PORT = 4230;
export const MAX_REQUEST_BODY_BYTES = 1048;
export const MAX_RESPONSE_BODY_BYTES = 16408;
export const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Read and validate VOXEL_SERVER_PORT from an environment-like object.
 * Returns a decimal port in the range 1..65535, or the default port
 * when the variable is unset. Throws on an invalid value so a
 * misconfigured deployment fails loudly instead of forwarding to the
 * wrong place.
 */
export function resolveVoxelServerPort(env = process.env) {
  const raw = env.VOXEL_SERVER_PORT;
  if (raw === undefined || raw === "") return DEFAULT_VOXEL_SERVER_PORT;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("VOXEL_SERVER_PORT must be a decimal port number");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("VOXEL_SERVER_PORT must be in range 1..65535");
  }
  return port;
}

function sendError(response, status, message) {
  if (response.headersSent || response.writableEnded) return;
  const body = Buffer.from(message, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store"
  });
  response.end(body);
}

function readBoundedBody(request, expectedLength, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const onData = (chunk) => {
      received += chunk.byteLength;
      if (received > expectedLength) {
        finish(Object.assign(new Error("Body exceeded declared length"), { code: "EBODYSIZE" }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (received !== expectedLength) {
        finish(Object.assign(new Error("Body truncated"), { code: "EBODYTRUNCATED" }));
        return;
      }
      finish(null, Buffer.concat(chunks, received));
    };
    const onAborted = () => {
      finish(Object.assign(new Error("Client disconnected"), { code: "ECLIENTABORT" }));
    };
    const onError = (error) => finish(error);

    const timer = setTimeout(() => {
      finish(Object.assign(new Error("Body read timed out"), { code: "ETIMEOUT" }));
    }, timeoutMs);

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
  });
}

function validateIncoming(request) {
  if (request.headers["transfer-encoding"] !== undefined) {
    return { ok: false, status: 400, message: "Transfer-Encoding is not supported" };
  }
  const header = request.headers["content-length"];
  if (header === undefined) {
    return { ok: false, status: 400, message: "Content-Length is required" };
  }
  const raw = Array.isArray(header) ? header[0] : header;
  if (Array.isArray(header) && header.length > 1) {
    return { ok: false, status: 400, message: "Content-Length must be sent once" };
  }
  if (!/^[0-9]+$/.test(raw)) {
    return { ok: false, status: 400, message: "Content-Length must be a decimal integer" };
  }
  const length = Number(raw);
  if (length <= 0) {
    return { ok: false, status: 400, message: "Content-Length must be positive" };
  }
  if (length > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, status: 413, message: "Request body exceeds the voxel sync limit" };
  }
  return { ok: true, length };
}

function forwardToUpstream(body, { host, port, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const upstreamRequest = httpRequest({
      host,
      port,
      path: VOXEL_SYNC_PATH,
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": body.byteLength,
        "connection": "close"
      }
    }, (upstreamResponse) => {
      const chunks = [];
      let received = 0;
      let capped = false;
      upstreamResponse.on("data", (chunk) => {
        if (capped) return;
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BODY_BYTES) {
          capped = true;
          upstreamResponse.destroy();
          finish(Object.assign(new Error("Upstream response exceeded the voxel sync limit"), { code: "EUPSTREAMSIZE" }));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (capped) return;
        finish(null, { status: upstreamResponse.statusCode, body: Buffer.concat(chunks, received) });
      });
      upstreamResponse.on("error", (error) => {
        if (capped) return;
        finish(error);
      });
    });

    upstreamRequest.on("error", (error) => {
      finish(Object.assign(error, { code: error.code || "EUPSTREAM" }));
    });

    const timer = setTimeout(() => {
      finish(Object.assign(new Error("Upstream exchange timed out"), { code: "ETIMEOUT" }));
      upstreamRequest.destroy();
    }, timeoutMs);

    upstreamRequest.end(body);
  });
}

/**
 * Create a handler bound to one upstream voxel server. The returned
 * function inspects the request path itself: it returns false (and
 * touches nothing else) for any path other than the voxel sync route,
 * so a caller can fall through to its own routing unchanged.
 */
export function createVoxelProxyHandler(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port === undefined ? resolveVoxelServerPort() : options.port;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

  return async function handleVoxelProxy(request, response, pathname) {
    if (pathname !== VOXEL_SYNC_PATH) return false;
    if (request.method !== "POST") {
      sendError(response, 405, "Only POST is accepted on the voxel sync route");
      return true;
    }

    const deadline = Date.now() + timeoutMs;
    const validation = validateIncoming(request);
    if (!validation.ok) {
      sendError(response, validation.status, validation.message);
      return true;
    }

    let body;
    try {
      body = await readBoundedBody(request, validation.length, Math.max(0, deadline - Date.now()));
    } catch (error) {
      if (error.code === "ECLIENTABORT") return true;
      if (error.code === "ETIMEOUT") {
        sendError(response, 504, "Timed out reading the request body");
      } else {
        sendError(response, 400, "Request body did not match Content-Length");
      }
      return true;
    }

    let upstreamResult;
    try {
      upstreamResult = await forwardToUpstream(body, { host, port, timeoutMs: Math.max(0, deadline - Date.now()) });
    } catch (error) {
      if (error.code === "ETIMEOUT") {
        sendError(response, 504, "Timed out waiting for the voxel server");
      } else {
        sendError(response, 502, "The voxel server is unavailable or returned an invalid response");
      }
      return true;
    }

    if (response.writableEnded) return true;
    response.writeHead(upstreamResult.status, {
      "content-type": "application/octet-stream",
      "content-length": upstreamResult.body.byteLength,
      "cache-control": "no-store"
    });
    response.end(upstreamResult.body);
    return true;
  };
}
