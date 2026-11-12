// Regression tests for companions/voxel/web/voxel-host.mjs: two
// concrete contract faults found in parent source review, fixed in
// the same follow-up as the #29 GPU-release correction.
//
// 1. `inFlight`/the request-timeout timer must survive the full
//    response body read, not just the headers, so a stalled body
//    still hits the deadline and a concurrent `reconnectNow()` cannot
//    start a second exchange while the first body is still pending.
// 2. Accepted response bytes must be capped at the protocol limit
//    *before* any unbounded allocation (declared `Content-Length` and
//    streamed-body checks).
// 3. `dispose()` must actively abort the current fetch/body read, not
//    merely stop scheduling further polls.
// 4. Exceptions from `buildRequest`/`onFrame` are application/
//    processing faults, never silently folded into the network
//    failure/retry path.
//
// All timing in these tests is driven by an injected fake clock (no
// real `setTimeout`/wall-clock sleeps), so they are both deterministic
// and fast: `advance(ms)` fires every timer whose deadline falls at or
// before `now + ms`, flushing microtasks between each firing so
// promise continuations (like the `.then` chain in `poll()`) run in
// the same relative order they would under a real clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createVoxelNetClient,
  VoxelNetStatus,
  ResponseTooLargeError,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "../companions/voxel/web/voxel-host.mjs";

/** A deterministic fake timer queue: `setTimeoutImpl`/`clearTimeoutImpl`
 * injected into the client, and `advance(ms)` to fire due timers. */
function createFakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();

  function setTimeoutImpl(ms, fn) {
    const handle = nextHandle++;
    timers.set(handle, { at: now + Math.max(0, ms), fn });
    return handle;
  }

  function clearTimeoutImpl(handle) {
    timers.delete(handle);
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }

  async function advance(ms) {
    const target = now + ms;
    await flushMicrotasks();
    for (;;) {
      let nextHandleToFire = null;
      let nextTimer = null;
      for (const [handle, timer] of timers) {
        if (timer.at <= target && (nextTimer === null || timer.at < nextTimer.at)) {
          nextHandleToFire = handle;
          nextTimer = timer;
        }
      }
      if (nextTimer === null) break;
      timers.delete(nextHandleToFire);
      now = nextTimer.at;
      nextTimer.fn();
      await flushMicrotasks();
    }
    now = target;
  }

  /** Synchronously fires the single earliest-due timer at or before
   * `now + ms`, without awaiting microtasks first or after. Used only
   * to assert that a timer callback itself throws synchronously
   * (e.g. the default `onError`'s rethrow), which an `async` `advance`
   * would otherwise turn into a rejected promise. */
  function advanceSync(ms) {
    const target = now + ms;
    let nextHandleToFire = null;
    let nextTimer = null;
    for (const [handle, timer] of timers) {
      if (timer.at <= target && (nextTimer === null || timer.at < nextTimer.at)) {
        nextHandleToFire = handle;
        nextTimer = timer;
      }
    }
    if (nextTimer === null) return;
    timers.delete(nextHandleToFire);
    now = nextTimer.at;
    nextTimer.fn();
  }

  return { setTimeoutImpl, clearTimeoutImpl, advance, advanceSync, flushMicrotasks };
}

/** A response whose body read never settles on its own; it only
 * rejects (as `fetch` does on a real abort) once `signal` aborts. */
function makeStalledResponse(signal) {
  let rejectRead;
  const pending = new Promise((_resolve, reject) => {
    rejectRead = reject;
  });
  signal.addEventListener("abort", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    rejectRead(error);
  });
  let cancelled = false;
  return {
    response: {
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read: () => pending,
            cancel: () => {
              cancelled = true;
              return Promise.resolve();
            },
          };
        },
      },
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test("a stalled response body still hits requestTimeoutMs, stays in-flight, and blocks a concurrent reconnectNow() poll", async () => {
  const clock = createFakeClock();
  let fetchCallCount = 0;
  let lastSignal = null;
  const statuses = [];

  const fetchImpl = (_url, init) => {
    fetchCallCount += 1;
    lastSignal = init.signal;
    const { response } = makeStalledResponse(init.signal);
    return Promise.resolve(response);
  };

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => new Uint8Array([1, 2, 3]),
    onFrame: () => assert.fail("onFrame must not be called: the body never actually resolves"),
    onStatus: (status) => statuses.push(status),
    fetchImpl,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    requestTimeoutMs: 2000,
    pollIntervalMs: 100,
    retryBaseMs: 50,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(fetchCallCount, 1);

  // Well before the 2000ms deadline: the exchange is still pending
  // (headers "arrived" synchronously above, but the body never did).
  // A concurrent reconnectNow() must be a no-op: it must NOT start a
  // second fetch while the first body read is still outstanding.
  client.reconnectNow();
  await clock.flushMicrotasks();
  assert.equal(fetchCallCount, 1, "reconnectNow() must not start a second exchange while the body is pending");
  assert.deepEqual(statuses, [], "no status change yet: the exchange has not failed or succeeded");

  // Advance past the 2000ms request-timeout deadline: this aborts the
  // controller, which rejects the pending body read, which must still
  // route through the ordinary failure/backoff path exactly once.
  await clock.advance(2000);
  assert.equal(lastSignal.aborted, true);
  assert.deepEqual(statuses, [VoxelNetStatus.OFFLINE]);

  // Only now (after the timed-out exchange is fully settled) is a new
  // exchange allowed to start, via the scheduled retry.
  await clock.advance(50);
  assert.equal(fetchCallCount, 2);

  client.dispose();
});

test("dispose() aborts the active in-flight exchange instead of leaving it to settle unobserved", async () => {
  const clock = createFakeClock();
  let lastSignal = null;
  const statuses = [];

  const fetchImpl = (_url, init) => {
    lastSignal = init.signal;
    const { response } = makeStalledResponse(init.signal);
    return Promise.resolve(response);
  };

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => new Uint8Array([1]),
    onFrame: () => assert.fail("onFrame must not be called after dispose()"),
    onStatus: (status) => statuses.push(status),
    fetchImpl,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    requestTimeoutMs: 2000,
    pollIntervalMs: 100,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(lastSignal.aborted, false);

  // Well before the request-timeout fires, dispose(): this alone must
  // abort the pending exchange (not merely stop scheduling new polls).
  client.dispose();
  assert.equal(lastSignal.aborted, true, "dispose() must actively abort the in-flight AbortController");

  // The rejection this abort causes must not produce any late status
  // callback: dispose() already set the disposed flag.
  await clock.advance(2000);
  assert.deepEqual(statuses, [], "no status callback may fire after dispose()");
});

test("a declared Content-Length over the protocol cap is rejected before any body read is attempted", async () => {
  const clock = createFakeClock();
  const statuses = [];
  let readerConstructed = false;

  const fetchImpl = () =>
    Promise.resolve({
      ok: true,
      headers: { get: (name) => (name === "content-length" ? String(DEFAULT_MAX_RESPONSE_BYTES + 1) : null) },
      body: {
        getReader() {
          readerConstructed = true;
          throw new Error("must not be called: the declared length already exceeds the cap");
        },
      },
    });

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => new Uint8Array([1]),
    onFrame: () => assert.fail("onFrame must not be called for an oversized response"),
    onStatus: (status) => statuses.push(status),
    fetchImpl,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    requestTimeoutMs: 2000,
    pollIntervalMs: 100,
    retryBaseMs: 50,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(readerConstructed, false, "no streaming reader is ever constructed for an over-cap declared length");
  assert.deepEqual(statuses, [VoxelNetStatus.OFFLINE]);

  client.dispose();
});

test("a streamed response body exceeding the cap is cancelled mid-read, never buffered to completion", async () => {
  const clock = createFakeClock();
  const statuses = [];
  let cancelCalled = false;
  const maxResponseBytes = 16;
  const chunk = new Uint8Array(10).fill(7);

  const fetchImpl = () =>
    Promise.resolve({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          let reads = 0;
          return {
            read: () => {
              reads += 1;
              if (reads > 3) return Promise.resolve({ done: true, value: undefined });
              // 3 chunks of 10 bytes = 30 bytes, over the 16-byte cap.
              return Promise.resolve({ done: false, value: chunk });
            },
            cancel: () => {
              cancelCalled = true;
              return Promise.resolve();
            },
          };
        },
      },
    });

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => new Uint8Array([1]),
    onFrame: () => assert.fail("onFrame must not be called for an oversized streamed body"),
    onStatus: (status) => statuses.push(status),
    fetchImpl,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    requestTimeoutMs: 2000,
    pollIntervalMs: 100,
    retryBaseMs: 50,
    maxResponseBytes,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(cancelCalled, true, "the over-cap stream reader must be cancelled, not drained to completion");
  assert.deepEqual(statuses, [VoxelNetStatus.OFFLINE]);

  client.dispose();
});

test("a buildRequest() exception is reported via onError and never treated as a network failure", async () => {
  const clock = createFakeClock();
  const statuses = [];
  const errors = [];
  let fetchCallCount = 0;
  const thrown = new Error("buildRequest boom");

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => {
      throw thrown;
    },
    onFrame: () => assert.fail("onFrame must not be called: buildRequest always throws"),
    onStatus: (status) => statuses.push(status),
    onError: (error, stage) => errors.push({ error, stage }),
    fetchImpl: () => {
      fetchCallCount += 1;
      return Promise.reject(new Error("fetch must never be called"));
    },
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    pollIntervalMs: 100,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(fetchCallCount, 0);
  assert.deepEqual(statuses, [], "a processing fault must never move status to offline");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, thrown);
  assert.equal(errors[0].stage, "buildRequest");

  // Polling must still continue (not deadlocked) after a processing fault.
  await clock.advance(100);
  assert.equal(errors.length, 2);

  client.dispose();
});

test("an onFrame() exception is reported via onError, never treated as a network failure, and polling continues", async () => {
  const clock = createFakeClock();
  const statuses = [];
  const errors = [];
  let fetchCallCount = 0;
  const thrown = new Error("onFrame boom");

  const fetchImpl = () => {
    fetchCallCount += 1;
    return Promise.resolve({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: new Uint8Array([9, 9]) });
            },
            cancel: () => Promise.resolve(),
          };
        },
      },
    });
  };

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => new Uint8Array([1]),
    onFrame: () => {
      throw thrown;
    },
    onStatus: (status) => statuses.push(status),
    onError: (error, stage) => errors.push({ error, stage }),
    fetchImpl,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    requestTimeoutMs: 2000,
    pollIntervalMs: 100,
  });

  client.start();
  await clock.flushMicrotasks();
  assert.equal(fetchCallCount, 1);
  assert.deepEqual(statuses, [], "a successfully-received frame that merely fails processing is not a network failure");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, thrown);
  assert.equal(errors[0].stage, "onFrame");

  // Confirms the poll loop is not stuck "in flight" forever after an
  // onFrame fault: the next scheduled poll actually starts a new fetch.
  await clock.advance(100);
  assert.equal(fetchCallCount, 2);

  client.dispose();
});

test("the default onError rethrows the error asynchronously via the injected timer when no onError is supplied", async () => {
  const clock = createFakeClock();
  const thrown = new Error("default onError boom");

  const client = createVoxelNetClient({
    url: "http://127.0.0.1:4230/vx/v1/sync",
    buildRequest: () => {
      throw thrown;
    },
    onFrame: () => {},
    onStatus: () => {},
    fetchImpl: () => Promise.reject(new Error("fetch must never be called")),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    pollIntervalMs: 1000,
  });

  client.start();
  await clock.flushMicrotasks();

  // The default `onError` schedules a rethrow via `setTimeoutImpl(0, ...)`
  // rather than swallowing the error. That rethrow timer fires at delay
  // 0, strictly before the regular poll-interval timer (scheduled at
  // 1000ms), so advancing time by 0ms must surface exactly that throw.
  assert.throws(
    () => clock.advanceSync(0),
    (error) => error === thrown,
  );

  client.dispose();
});

test("the response-too-large error constructed for an oversized body is a ResponseTooLargeError", () => {
  const error = new ResponseTooLargeError(99999, DEFAULT_MAX_RESPONSE_BYTES);
  assert.equal(error.name, "ResponseTooLargeError");
  assert.ok(error instanceof Error);
  assert.match(error.message, /exceeds the 16408-byte protocol cap/);
});
