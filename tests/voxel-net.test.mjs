import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoxelNetClient, VoxelNetStatus } from "../companions/voxel/web/voxel-host.mjs";

// A tiny deterministic fake scheduler: `advance(ms)` runs every timer
// whose deadline has passed, in deadline order. This lets tests drive
// the exact 250ms..4s backoff and the 2s abort window without real
// wall-clock waits.
function makeFakeScheduler() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeoutImpl(ms, fn) {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeoutImpl(id) {
            timers.delete(id);
        },
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at <= now && timers.has(id)) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        },
        pendingCount() {
            return timers.size;
        },
    };
}

function makeAbortControllerStub() {
    // jsdom/undici-free stand-in: records whether `abort()` was called.
    return class FakeAbortController {
        constructor() {
            this.signal = { aborted: false };
        }
        abort() {
            this.signal.aborted = true;
        }
    };
}

test("one in-flight request at a time: a second poll before response settles is skipped", async () => {
    const scheduler = makeFakeScheduler();
    let fetchCalls = 0;
    let resolveFetch;
    const fetchImpl = () => {
        fetchCalls += 1;
        return new Promise((resolve) => {
            resolveFetch = resolve;
        });
    };
    const statuses = [];
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1, 2, 3]),
        onFrame: () => {},
        onStatus: (s) => statuses.push(s),
        fetchImpl,
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });
    client.start();
    // A second manual poll attempt while the first is still pending must not fetch again.
    scheduler.advance(50);
    assert.equal(fetchCalls, 1);

    resolveFetch({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    await Promise.resolve();
    await Promise.resolve();
    client.dispose();
});

test("each request aborts after the 2s request timeout", async () => {
    const scheduler = makeFakeScheduler();
    const originalAbortController = globalThis.AbortController;
    globalThis.AbortController = makeAbortControllerStub();
    try {
        let capturedSignal = null;
        const fetchImpl = (_url, init) => {
            capturedSignal = init.signal;
            return new Promise(() => {}); // never resolves
        };
        const client = createVoxelNetClient({
            url: "http://127.0.0.1:4230/vx/v1/sync",
            buildRequest: () => new Uint8Array([1]),
            onFrame: () => {},
            onStatus: () => {},
            fetchImpl,
            setTimeoutImpl: scheduler.setTimeoutImpl,
            clearTimeoutImpl: scheduler.clearTimeoutImpl,
            requestTimeoutMs: 2000,
        });
        client.start();
        assert.equal(capturedSignal.aborted, false);
        scheduler.advance(2000);
        assert.equal(capturedSignal.aborted, true);
        client.dispose();
    } finally {
        globalThis.AbortController = originalAbortController;
    }
});

test("backoff is capped exponential: 250ms, 500ms, 1000ms, ... capped at 4000ms", async () => {
    const scheduler = makeFakeScheduler();
    const delays = [];
    let lastScheduleTime = 0;
    const originalSetTimeout = scheduler.setTimeoutImpl;
    const trackingSetTimeout = (ms, fn) => {
        delays.push(ms);
        return originalSetTimeout(ms, fn);
    };
    const fetchImpl = () => Promise.reject(new Error("network down"));
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1]),
        onFrame: () => {},
        onStatus: () => {},
        fetchImpl,
        setTimeoutImpl: trackingSetTimeout,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
        requestTimeoutMs: 2000,
        retryBaseMs: 250,
        retryMaxMs: 4000,
        pollIntervalMs: 100,
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    // First failure schedules a 250ms retry (plus the 2000ms abort timer
    // for the request that just failed, already cleared).
    for (let i = 0; i < 6; i++) {
        scheduler.advance(4000);
        await Promise.resolve();
        await Promise.resolve();
    }
    client.dispose();
    const retryDelays = delays.filter((_, i) => i % 2 === 1);
    assert.deepEqual(retryDelays.slice(0, 5), [250, 500, 1000, 2000, 4000]);
    assert.equal(retryDelays[5], 4000, "stays capped at 4000ms");
});

test("status reports offline on failure and online once the host confirms a decoded frame", async () => {
    const scheduler = makeFakeScheduler();
    const statuses = [];
    let shouldFail = true;
    const fetchImpl = () =>
        shouldFail
            ? Promise.reject(new Error("down"))
            : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1]),
        onFrame: () => client.reportOnline(),
        onStatus: (s) => statuses.push(s),
        fetchImpl,
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(statuses.includes(VoxelNetStatus.OFFLINE));
    shouldFail = false;
    scheduler.advance(300);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(client.status, VoxelNetStatus.ONLINE);
    client.dispose();
});

test("version error stops all retry and further polling permanently", async () => {
    const scheduler = makeFakeScheduler();
    let fetchCalls = 0;
    const fetchImpl = () => {
        fetchCalls += 1;
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    };
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1]),
        onFrame: () => {},
        onStatus: () => {},
        fetchImpl,
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
        pollIntervalMs: 50,
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    client.reportVersionError();
    const callsAtVersionError = fetchCalls;
    scheduler.advance(10_000);
    await Promise.resolve();
    assert.equal(fetchCalls, callsAtVersionError, "no request after a Version error");
    client.dispose();
});

test("dispose aborts polling and schedules no further requests or status callbacks", async () => {
    const scheduler = makeFakeScheduler();
    let fetchCalls = 0;
    const statusesAfterDispose = [];
    let afterDispose = false;
    const fetchImpl = () => {
        fetchCalls += 1;
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    };
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1]),
        onFrame: () => {},
        onStatus: (s) => {
            if (afterDispose) statusesAfterDispose.push(s);
        },
        fetchImpl,
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
        pollIntervalMs: 50,
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    afterDispose = true;
    client.dispose();
    const callsAtDispose = fetchCalls;
    scheduler.advance(10_000);
    await Promise.resolve();
    assert.equal(fetchCalls, callsAtDispose, "no post-dispose fetch");
    assert.equal(statusesAfterDispose.length, 0, "no post-dispose status mutation");
});

test("discarded-input counter tracks inputs noted while offline", () => {
    const scheduler = makeFakeScheduler();
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array(0),
        onFrame: () => {},
        onStatus: () => {},
        fetchImpl: () => Promise.reject(new Error("down")),
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });
    assert.equal(client.discardedInputCount(), 0);
    client.noteDiscardedInput();
    client.noteDiscardedInput();
    assert.equal(client.discardedInputCount(), 2);
    client.dispose();
});

test("reconnectNow resets backoff and polls immediately", async () => {
    const scheduler = makeFakeScheduler();
    let fetchCalls = 0;
    const fetchImpl = () => {
        fetchCalls += 1;
        return Promise.reject(new Error("down"));
    };
    const client = createVoxelNetClient({
        url: "http://127.0.0.1:4230/vx/v1/sync",
        buildRequest: () => new Uint8Array([1]),
        onFrame: () => {},
        onStatus: () => {},
        fetchImpl,
        setTimeoutImpl: scheduler.setTimeoutImpl,
        clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeReconnect = fetchCalls;
    client.reconnectNow();
    assert.equal(fetchCalls, callsBeforeReconnect + 1, "reconnectNow polls immediately");
    client.dispose();
});
