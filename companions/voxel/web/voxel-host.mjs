// Host-side mixed-mode poller for the `VXP1` protocol. See
// `docs/architecture/voxel-protocol.md` ("Client staging exports" and
// the retry/abort rules). This module has no WASM/GPU code: it only
// moves bytes between `fetch` and a byte-buffer sink the embedding
// host controls. The runtime frame WASM never calls the network
// directly.
//
// Contract implemented here:
// - One in-flight request at a time. A new poll is skipped while a
//   request is outstanding.
// - Each request aborts after `requestTimeoutMs` (default 2000) via
//   `AbortController`.
// - On failure (network error, non-200, or an aborted request), retry
//   with capped exponential backoff: `retryBaseMs * 2^n`, capped at
//   `retryMaxMs` (defaults 250ms and 4000ms).
// - `status` is always one of a fixed set of host-visible strings so a
//   UI can render it without inspecting internals.
// - After `dispose()`, no further request is sent and no further
//   status/frame callback fires, even if an in-flight request settles
//   late.

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

/**
 * @param {object} options
 * @param {string} options.url - The sync endpoint, e.g. "http://127.0.0.1:4230/vx/v1/sync".
 * @param {() => Uint8Array} options.buildRequest - Returns the next request frame bytes.
 * @param {(frame: Uint8Array) => void} options.onFrame - Called with each successful response frame.
 * @param {(status: string) => void} options.onStatus - Called whenever the status changes.
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch, for tests.
 * @param {(ms: number, fn: () => void) => number} [options.setTimeoutImpl]
 * @param {(handle: number) => void} [options.clearTimeoutImpl]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.retryMaxMs]
 * @param {number} [options.pollIntervalMs]
 */
export function createVoxelNetClient(options) {
  const {
    url,
    buildRequest,
    onFrame,
    onStatus,
    fetchImpl = (...args) => fetch(...args),
    setTimeoutImpl = (ms, fn) => setTimeout(fn, ms),
    clearTimeoutImpl = (handle) => clearTimeout(handle),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  let disposed = false;
  let inFlight = false;
  let retryAttempt = 0;
  let status = VoxelNetStatus.CONNECTING;
  let pollHandle = null;
  let retryHandle = null;
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
    const body = buildRequest();
    if (!body || body.length === 0) {
      scheduleNextPoll(pollIntervalMs);
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    const abortHandle = setTimeoutImpl(requestTimeoutMs, () => controller.abort());

    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        clearTimeoutImpl(abortHandle);
        inFlight = false;
        if (disposed) return;
        if (!response.ok) {
          handleFailure();
          return;
        }
        const buf = new Uint8Array(await response.arrayBuffer());
        retryAttempt = 0;
        onFrame(buf);
        scheduleNextPoll(pollIntervalMs);
      })
      .catch(() => {
        clearTimeoutImpl(abortHandle);
        inFlight = false;
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

  /** Stops all polling/retry timers and in-flight aborts. Idempotent. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (pollHandle !== null) clearTimeoutImpl(pollHandle);
    if (retryHandle !== null) clearTimeoutImpl(retryHandle);
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
