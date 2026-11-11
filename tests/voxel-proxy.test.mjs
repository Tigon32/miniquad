// STE-aligned draft. Full dictionary review not done.
//
// Focused tests for the voxel sync gateway (POST /vx/v1/sync). Every
// test opens its own ephemeral servers, so it never touches the fixed
// browser fixture ports (4173, 4174) or a real native voxel server.
// Upstream behavior is a fake HTTP server; these tests prove gateway
// forwarding, bounds, and rejection, not the native VXP1 protocol.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import {
  createVoxelProxyHandler,
  resolveVoxelServerPort,
  VOXEL_SYNC_PATH,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES
} from "./browser/voxel-proxy.mjs";
import { createBrowserFixtureServer } from "./browser/serve.mjs";

async function listenEphemeral(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function startFakeUpstream(handler) {
  const server = createServer(handler);
  const port = await listenEphemeral(server);
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

async function startGateway(voxelProxyOptions = {}) {
  const server = createBrowserFixtureServer({
    voxelProxy: createVoxelProxyHandler(voxelProxyOptions)
  });
  const port = await listenEphemeral(server);
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

function rawRequest(port, headLines, bodyText = "") {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.write(headLines.join("\r\n") + "\r\n\r\n" + bodyText);
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const [statusLine, ...rest] = raw.split("\r\n");
      const match = /^HTTP\/1\.\d (\d\d\d)/.exec(statusLine || "");
      resolvePromise({ status: match ? Number(match[1]) : undefined, raw, rest });
    });
    socket.on("error", rejectPromise);
  });
}

function requestGateway(port, { method = "POST", path = VOXEL_SYNC_PATH, headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", rejectPromise);
    });
    req.on("error", rejectPromise);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function fixedHeaderBody(payloadByte, payloadLength) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x31505856, 0); // "VXP1" little-endian marker, opaque to the gateway
  const payload = Buffer.alloc(payloadLength, payloadByte);
  return Buffer.concat([header, payload]);
}

test("gateway forwards exact request bytes and mirrors upstream status with no-store", async () => {
  let upstreamCalls = 0;
  let seenRequest = null;
  const sentBody = fixedHeaderBody(0xab, 10);
  const upstreamResponseBody = fixedHeaderBody(0xcd, 20);
  const upstream = await startFakeUpstream((req, res) => {
    upstreamCalls++;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seenRequest = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(upstreamResponseBody);
    });
  });
  const gateway = await startGateway({ port: upstream.port });

  try {
    const response = await requestGateway(gateway.port, {
      headers: { "content-type": "application/octet-stream", "content-length": sentBody.byteLength },
      body: sentBody
    });

    assert.equal(upstreamCalls, 1);
    assert.equal(seenRequest.method, "POST");
    assert.equal(seenRequest.url, VOXEL_SYNC_PATH);
    assert.ok(seenRequest.body.equals(sentBody), "upstream must receive the exact request bytes");

    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-type"], "application/octet-stream");
    assert.ok(response.body.equals(upstreamResponseBody), "client must receive the exact response bytes");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway does not forward browser authorization, cookie, or custom headers", async () => {
  let seenHeaders = null;
  const upstream = await startFakeUpstream((req, res) => {
    seenHeaders = req.headers;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fixedHeaderBody(0, 4));
    });
  });
  const gateway = await startGateway({ port: upstream.port });

  try {
    const body = fixedHeaderBody(1, 4);
    await requestGateway(gateway.port, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": body.byteLength,
        "authorization": "Bearer secret-token",
        "cookie": "session=abc123",
        "x-custom-trace": "should-not-cross"
      },
      body
    });

    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenHeaders.cookie, undefined);
    assert.equal(seenHeaders["x-custom-trace"], undefined);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway rejects invalid, missing, oversize, and chunked requests before calling upstream", async () => {
  let upstreamCalls = 0;
  const upstream = await startFakeUpstream((req, res) => {
    upstreamCalls++;
    res.writeHead(200);
    res.end();
  });
  const gateway = await startGateway({ port: upstream.port });

  try {
    const missingLength = await rawRequest(gateway.port, [
      `POST ${VOXEL_SYNC_PATH} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Content-Type: application/octet-stream",
      "Connection: close"
    ], "x");
    assert.equal(missingLength.status, 400);

    const invalidLength = await requestGateway(gateway.port, {
      headers: { "content-length": "not-a-number" }, body: Buffer.from("x")
    });
    assert.equal(invalidLength.status, 400);

    const oversize = await requestGateway(gateway.port, {
      headers: { "content-length": MAX_REQUEST_BODY_BYTES + 1 },
      body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 1)
    });
    assert.equal(oversize.status, 413);

    const chunked = await rawRequest(gateway.port, [
      `POST ${VOXEL_SYNC_PATH} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Transfer-Encoding: chunked",
      "Connection: close"
    ], "1\r\nx\r\n0\r\n\r\n");
    assert.equal(chunked.status, 400);

    assert.equal(upstreamCalls, 0, "an invalid request must never reach upstream");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway rejects a Content-Length and Transfer-Encoding combination without calling upstream", async () => {
  let upstreamCalls = 0;
  const upstream = await startFakeUpstream((req, res) => { upstreamCalls++; res.writeHead(200); res.end(); });
  const gateway = await startGateway({ port: upstream.port });

  try {
    const socket = connect(gateway.port, "127.0.0.1");
    await once(socket, "connect");
    const body = "abcd";
    socket.write(
      `POST ${VOXEL_SYNC_PATH} HTTP/1.1\r\n` +
      "Host: 127.0.0.1\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Transfer-Encoding: chunked\r\n" +
      "Connection: close\r\n\r\n" + body
    );
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal(upstreamCalls, 0);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway rejects a truncated request body without calling upstream", async () => {
  let upstreamCalls = 0;
  const upstream = await startFakeUpstream((req, res) => { upstreamCalls++; res.writeHead(200); res.end(); });
  const gateway = await startGateway({ port: upstream.port, timeoutMs: 400 });

  try {
    const socket = connect(gateway.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST ${VOXEL_SYNC_PATH} HTTP/1.1\r\n` +
      "Host: 127.0.0.1\r\n" +
      "Content-Length: 20\r\n" +
      "Content-Type: application/octet-stream\r\n\r\n" +
      "short"
    );
    socket.end();
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    // The server must either answer with a client error, or close the
    // half-written connection without a response; either way it must
    // not hang and it must never call the upstream server.
    if (chunks.length > 0) {
      const raw = Buffer.concat(chunks).toString("utf8");
      assert.match(raw, /^HTTP\/1\.1 4\d\d/);
    }
    assert.equal(upstreamCalls, 0);

    const health = await requestGateway(gateway.port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200, "the server must keep serving after a truncated request");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway answers 502 when upstream is unreachable", async () => {
  const closedUpstream = await startFakeUpstream((req, res) => res.end());
  await closedUpstream.close();
  const gateway = await startGateway({ port: closedUpstream.port });

  try {
    const body = fixedHeaderBody(2, 4);
    const response = await requestGateway(gateway.port, {
      headers: { "content-length": body.byteLength }, body
    });
    assert.equal(response.status, 502);
  } finally {
    await gateway.close();
  }
});

test("gateway answers 504 when upstream does not respond in time", async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.on("data", () => {});
    // Never respond, to force the gateway's own timeout.
  });
  const gateway = await startGateway({ port: upstream.port, timeoutMs: 200 });

  try {
    const body = fixedHeaderBody(3, 4);
    const response = await requestGateway(gateway.port, {
      headers: { "content-length": body.byteLength }, body
    });
    assert.equal(response.status, 504);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway mirrors an explicit upstream failure status with a bounded body", async () => {
  const upstream = await startFakeUpstream((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(422, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("rejected"));
    });
  });
  const gateway = await startGateway({ port: upstream.port });

  try {
    const body = fixedHeaderBody(4, 4);
    const response = await requestGateway(gateway.port, {
      headers: { "content-length": body.byteLength }, body
    });
    assert.equal(response.status, 422);
    assert.ok(response.body.equals(Buffer.from("rejected")));
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway caps and rejects an oversize chunked upstream response without hanging", async () => {
  const upstream = await startFakeUpstream((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const oversized = Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 4096, 9);
      res.end(oversized); // no content-length: Node sends this chunked
    });
  });
  const gateway = await startGateway({ port: upstream.port, timeoutMs: 1500 });

  try {
    const body = fixedHeaderBody(5, 4);
    const response = await requestGateway(gateway.port, {
      headers: { "content-length": body.byteLength }, body
    });
    assert.equal(response.status, 502);
    assert.ok(response.body.byteLength <= MAX_RESPONSE_BODY_BYTES);

    const health = await requestGateway(gateway.port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200, "the server must keep serving after an oversize upstream response");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway rejects non-POST methods on the voxel sync route", async () => {
  const upstream = await startFakeUpstream((req, res) => res.end());
  const gateway = await startGateway({ port: upstream.port });

  try {
    const response = await requestGateway(gateway.port, { method: "GET" });
    assert.equal(response.status, 405);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("gateway leaves unrelated routes to the existing static server", async () => {
  const gateway = await startGateway({ port: 1 });
  try {
    const response = await requestGateway(gateway.port, { method: "GET", path: "/health" });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString("utf8"), "ok");
  } finally {
    await gateway.close();
  }
});

test("resolveVoxelServerPort validates VOXEL_SERVER_PORT and defaults to 4230", () => {
  assert.equal(resolveVoxelServerPort({}), 4230);
  assert.equal(resolveVoxelServerPort({ VOXEL_SERVER_PORT: "8080" }), 8080);
  assert.throws(() => resolveVoxelServerPort({ VOXEL_SERVER_PORT: "0" }));
  assert.throws(() => resolveVoxelServerPort({ VOXEL_SERVER_PORT: "65536" }));
  assert.throws(() => resolveVoxelServerPort({ VOXEL_SERVER_PORT: "abc" }));
  assert.throws(() => resolveVoxelServerPort({ VOXEL_SERVER_PORT: "-1" }));
});
