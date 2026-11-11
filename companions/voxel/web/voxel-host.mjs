// Host-side mixed-mode poller for the `VXP1` protocol. See
// `docs/architecture/voxel-protocol.md` ("Client staging exports" and
// the retry/abort rules). This module has no WASM/GPU code: it only
// moves bytes between `fetch` and a byte-buffer sink the embedding
// host controls. The runtime frame WASM never calls the network
// directly.
//
// Contract implemented here:
// - One in-flight request at a time. A new poll is skipped while a
//   request is outstanding. "In flight" covers the full request/
//   response exchange, including reading the response body: `inFlight`
//   and the request-timeout timer both stay live until the body has
//   been fully read (or has failed/been rejected as too large), not
//   merely until the response headers arrive. A response body that
//   stalls after headers therefore still hits the request timeout,
//   and `reconnectNow()`/the next scheduled poll cannot start a second
//   exchange while the first body read is still pending.
// - Each request (headers through full body) aborts after
//   `requestTimeoutMs` (default 2000) via `AbortController`. The same
//   controller also aborts the in-progress body read, since the Fetch
//   standard propagates an abort signal to a response's body stream.
// - Accepted response bytes are capped at `maxResponseBytes` (default
//   `HEADER_LEN + MAX_SERVER_BODY` = 16408, see
//   `companions/voxel/src/protocol.rs`) *before* any unbounded
//   allocation: a declared `Content-Length` over the cap is rejected
//   without reading the body, and a streamed body that exceeds the cap
//   is cancelled mid-read, so a misbehaving or malicious server can
//   never force an unbounded buffer allocation here.
// - On failure (network error, non-200, an aborted request, or an
//   oversized response), retry with capped exponential backoff:
//   `retryBaseMs * 2^n`, capped at `retryMaxMs` (defaults 250ms and
//   4000ms).
// - `status` is always one of a fixed set of host-visible strings so a
//   UI can render it without inspecting internals.
// - After `dispose()`, no further request is sent, no further
//   status/frame callback fires (even if an in-flight request settles
//   late), and the in-flight request/body read (if any) is actively
//   aborted rather than left to run to completion unobserved.
// - Exceptions thrown by the host-supplied `buildRequest`/`onFrame`
//   callbacks are application/processing faults, not network
//   failures: they are never silently folded into the network
//   failure/retry-backoff path. They are reported through the
//   dedicated `onError(error, stage)` callback instead, where `stage`
//   is `"buildRequest"` or `"onFrame"`. The default `onError` rethrows
//   asynchronously (via the injectable timer), so an integrator that
//   does not supply one still gets a visible, uncaught failure instead
//   of a silently swallowed one.

/** Host-visible connection states. */
export const VoxelNetStatus = Object.freeze({
  CONNECTING: 'connecting',
  ONLINE: 'online',
  OFFLINE: 'offline',
  VERSION_ERROR: 'version-error',
});

const DEFAULT_REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 4000;
const DEFAULT_POLL_INTERVAL_MS = 100;
/** `HEADER_LEN (24) + MAX_SERVER_BODY (16384)`, mirrored from
 * `companions/voxel/src/protocol.rs`'s `NET_BUF_LEN`-sized frame cap:
 * the largest frame the server is ever allowed to send. */
export const DEFAULT_MAX_RESPONSE_BYTES = 24 + 16384;

/** Thrown (and caught internally) when a response exceeds `maxResponseBytes`. */
export class ResponseTooLargeError extends Error {
  constructor(observedOrDeclaredBytes, maxBytes) {
    super(`voxel-host: response body (${observedOrDeclaredBytes} bytes) exceeds the ${maxBytes}-byte protocol cap`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Reads a `fetch` `Response` body into a `Uint8Array`, enforcing
 * `maxBytes` before any unbounded allocation: a declared
 * `Content-Length` over the cap is rejected immediately (no body
 * read), and a streamed body is cancelled as soon as the running
 * total exceeds the cap. Falls back to `response.arrayBuffer()` only
 * when no streaming body reader is available (e.g. a minimal test
 * double), still checking the resulting length against `maxBytes`.
 */
async function readBoundedResponseBody(response, maxBytes) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    const declaredLen = Number(declared);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      throw new ResponseTooLargeError(declaredLen, maxBytes);
    }
  }
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new ResponseTooLargeError(buf.byteLength, maxBytes);
  }
  return buf;
}

/**
 * @param {object} options
 * @param {string} options.url - The sync endpoint, e.g. "http://127.0.0.1:4230/vx/v1/sync".
 * @param {() => Uint8Array} options.buildRequest - Returns the next request frame bytes.
 * @param {(frame: Uint8Array) => void} options.onFrame - Called with each successful response frame.
 * @param {(status: string) => void} options.onStatus - Called whenever the status changes.
 * @param {(error: Error, stage: 'buildRequest' | 'onFrame') => void} [options.onError] - Called when
 *   `buildRequest` or `onFrame` throws; never conflated with a network failure. Defaults to
 *   rethrowing the error asynchronously so it is not silently swallowed.
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch, for tests.
 * @param {(ms: number, fn: () => void) => number} [options.setTimeoutImpl]
 * @param {(handle: number) => void} [options.clearTimeoutImpl]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.retryMaxMs]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.maxResponseBytes]
 */
export function createVoxelNetClient(options) {
  const {
    url,
    buildRequest,
    onFrame,
    onStatus,
    onError = (error) => {
      setTimeoutImpl(0, () => {
        throw error;
      });
    },
    fetchImpl = (...args) => fetch(...args),
    setTimeoutImpl = (ms, fn) => setTimeout(fn, ms),
    clearTimeoutImpl = (handle) => clearTimeout(handle),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;

  let disposed = false;
  let inFlight = false;
  let retryAttempt = 0;
  let status = VoxelNetStatus.CONNECTING;
  let pollHandle = null;
  let retryHandle = null;
  /** The `AbortController` for the currently in-flight exchange, if any, so `dispose()` can abort it. */
  let activeController = null;
  /** Count of inputs discarded while offline (host-visible metric). */
  let discardedWhileOffline = 0;

  function setStatus(next) {
    if (disposed) return;
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function scheduleNextPoll(delayMs) {
    if (disposed) return;
    pollHandle = setTimeoutImpl(delayMs, poll);
  }

  function poll() {
    if (disposed || inFlight) return;
    if (status === VoxelNetStatus.VERSION_ERROR) {
      // Version errors stop all further requests. Never auto-retry.
      return;
    }
    let body;
    try {
      body = buildRequest();
    } catch (error) {
      // A `buildRequest` fault is an application/processing error, not
      // a network failure: never route it through `handleFailure()`'s
      // offline/retry-backoff path.
      onError(error, 'buildRequest');
      scheduleNextPoll(pollIntervalMs);
      return;
    }
    if (!body || body.length === 0) {
      scheduleNextPoll(pollIntervalMs);
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    const abortHandle = setTimeoutImpl(requestTimeoutMs, () => controller.abort());

    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          clearTimeoutImpl(abortHandle);
          inFlight = false;
          activeController = null;
          if (disposed) return;
          handleFailure();
          return;
        }
        // `inFlight`, the request-timeout timer, and `activeController`
        // all stay live through the full body read below: a stalled or
        // oversized body must still hit `requestTimeoutMs` and must
        // still block a second concurrent exchange, not just the time
        // to the response headers.
        let buf;
        try {
          buf = await readBoundedResponseBody(response, maxResponseBytes);
        } catch (error) {
          clearTimeoutImpl(abortHandle);
          inFlight = false;
          activeController = null;
          if (disposed) return;
          handleFailure();
          return;
        }
        clearTimeoutImpl(abortHandle);
        inFlight = false;
        activeController = null;
        if (disposed) return;
        retryAttempt = 0;
        try {
          onFrame(buf);
        } catch (error) {
          // An `onFrame` fault is an application/processing error, not
          // a network failure: surface it distinctly instead of
          // falling into the `.catch()` below's offline/retry path.
          onError(error, 'onFrame');
        }
        scheduleNextPoll(pollIntervalMs);
      })
      .catch(() => {
        clearTimeoutImpl(abortHandle);
        inFlight = false;
        activeController = null;
        if (disposed) return;
        handleFailure();
      });
  }

  function handleFailure() {
    setStatus(VoxelNetStatus.OFFLINE);
    const delay = Math.min(retryBaseMs * 2 ** retryAttempt, retryMaxMs);
    retryAttempt += 1;
    retryHandle = setTimeoutImpl(delay, poll);
  }

  /** Called by the host when a decoded frame reports a version error. */
  function reportVersionError() {
    setStatus(VoxelNetStatus.VERSION_ERROR);
    // No retry, no reconnect: per contract, a version mismatch stops.
  }

  /** Called by the host when a decoded frame confirms the server is live. */
  function reportOnline() {
    setStatus(VoxelNetStatus.ONLINE);
  }

  /** Called by the host when a resync (Hello) is in flight. */
  function reportConnecting() {
    setStatus(VoxelNetStatus.CONNECTING);
  }

  /** Resets backoff and immediately polls again (the "Reconnect now" action). */
  function reconnectNow() {
    if (disposed) return;
    if (retryHandle !== null) {
      clearTimeoutImpl(retryHandle);
      retryHandle = null;
    }
    retryAttempt = 0;
    setStatus(VoxelNetStatus.CONNECTING);
    poll();
  }

  /** Records one input discarded because the client is offline/disposed. */
  function noteDiscardedInput() {
    discardedWhileOffline += 1;
  }

  function discardedInputCount() {
    return discardedWhileOffline;
  }

  /** Stops all polling/retry timers, and aborts any in-flight exchange
   * (request or response-body read) rather than leaving it to settle
   * unobserved. Idempotent. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (pollHandle !== null) clearTimeoutImpl(pollHandle);
    if (retryHandle !== null) clearTimeoutImpl(retryHandle);
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
  }

  function start() {
    poll();
  }

  return {
    start,
    dispose,
    reconnectNow,
    reportVersionError,
    reportOnline,
    reportConnecting,
    noteDiscardedInput,
    discardedInputCount,
    get status() {
      return status;
    },
  };
}
