import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import {
    CENTER_RGBA, CONTRACT, CORNER_RGBA, checkProgress, checkReadback, checkRecord, checkRejection, classify,
    pixelPositions, planLane, summarize, validateStatus,
} from "./contract.mjs";
import { INJECTIONS, instrument } from "./instrumentation.mjs";
import { comparePlaywright, hardwareObservation, parseArgs, receiptPath } from "./run-proof.mjs";
import { checkPort, createProofServer, listen, resolveAsset } from "../../scripts/webgpu-proof-serve.mjs";

function status(overrides = {}) {
    return {
        contract: CONTRACT, candidate: "manual", reporter: "rust", mode: "render", phase: "running",
        error: null, canvasFormat: "bgra8unorm", surface: {width: 256, height: 256},
        frameCount: 3, resizeCount: 0,
        input: {pointer: null, key: null, focused: false, focusChanges: 0},
        readback: {id: 0, state: "idle", width: 0, height: 0, center: null, corner: null, error: null},
        ...overrides,
    };
}

test("a complete running status has the contract shape", () => {
    assert.deepEqual(validateStatus(status(), {candidate: "manual", mode: "render"}), []);
});

test("status checks reject wrong codes, reporters, and missing errors", () => {
    assert.match(validateStatus(status({phase: "failed"})).join(), /failed needs an error/);
    assert.match(validateStatus(status({phase: "failed", error: {code: "gpu-broke", message: "x"}})).join(),
        /not a contract code/);
    assert.match(validateStatus(status({reporter: "host", phase: "failed",
        error: {code: "adapter-unavailable", message: "x"}})).join(), /host cannot report adapter-unavailable/);
    assert.match(validateStatus(status({reporter: "host"})).join(), /host can report only loading or failed/);
    assert.match(validateStatus(status({phase: "failed", error: {code: "internal", message: ""}})).join(),
        /non-empty/);
    assert.match(validateStatus(status({phase: "failed", error: {code: "internal", message: "é".repeat(2049)}})).join(),
        /longer than 4096 bytes/);
    assert.match(validateStatus(status({phase: "lost", error: {code: "internal", message: "x"}})).join(),
        /lost needs device-lost/);
    assert.match(validateStatus(status({phase: "failed", error: {code: "internal", message: "x", reason: "destroyed"}}))
        .join(), /reason is only for device-lost/);
    assert.match(validateStatus(status(), {candidate: "wgpu"}).join(), /candidate differs/);
});

test("a host-reported WASM load failure is valid", () => {
    assert.deepEqual(validateStatus(status({reporter: "host", phase: "failed", frameCount: 0,
        error: {code: "wasm-load-failed", message: "404"}})), []);
});

test("terminal phases cannot change and frames cannot continue after them", () => {
    const lost = status({phase: "lost", error: {code: "device-lost", message: "x", reason: "destroyed"}});
    assert.match(checkProgress(lost, status()).join(), /terminal phase lost changed/);
    assert.match(checkProgress(lost, {...lost, frameCount: 4}).join(), /after terminal phase/);
    assert.match(checkProgress(status({frameCount: 5}), status()).join(), /frameCount decreased/);
    assert.deepEqual(checkProgress(status(), status({frameCount: 9})), []);
});

test("readback check uses exact RGBA at the contract positions", () => {
    assert.deepEqual(pixelPositions(320, 200), {center: [160, 100], corner: [0, 0]});
    assert.deepEqual(pixelPositions(255, 255), {center: [127, 127], corner: [0, 0]});
    const ready = status({readback: {id: 2, state: "ready", width: 256, height: 256,
        center: [...CENTER_RGBA], corner: [...CORNER_RGBA], error: null}});
    assert.deepEqual(checkReadback(ready, 2, {width: 256, height: 256}), []);
    const bgra = {...ready, readback: {...ready.readback, center: [0, 0, 255, 255], corner: [255, 0, 0, 255]}};
    assert.equal(checkReadback(bgra, 2, {width: 256, height: 256}).length, 2);
    assert.match(checkReadback(ready, 1, {width: 256, height: 256}).join(), /id 2 is not 1/);
    assert.match(checkReadback(ready, 2, {width: 320, height: 200}).join(), /size/);
    const nearly = {...ready, readback: {...ready.readback, center: [254, 0, 0, 255]}};
    assert.match(checkReadback(nearly, 2, {width: 256, height: 256}).join(), /center/);
});

test("rejections need the code, the reporter, and no frames", () => {
    const failed = status({phase: "failed", frameCount: 0, error: {code: "adapter-unavailable", message: "x"}});
    assert.deepEqual(checkRejection(failed, "adapter-unavailable"), []);
    assert.match(checkRejection(failed, "api-unavailable").join(), /not api-unavailable/);
    assert.match(checkRejection({...failed, frameCount: 1}, "adapter-unavailable").join(), /frameCount/);
    assert.match(checkRejection(failed, "wasm-load-failed").join(), /reporter is rust, not host/);
    assert.match(checkRejection(status(), "adapter-unavailable").join(), /not failed/);
});

test("records fail on WebGL, missing WebGPU, validation errors, and runtime errors", () => {
    const clean = {contexts: ["webgpu"], validationErrors: [], rejections: [], errors: []};
    assert.deepEqual(checkRecord(clean, {rendering: true}), []);
    assert.match(checkRecord({...clean, contexts: ["webgpu", "webgl2"]}, {rendering: false}).join(), /WebGL context/);
    assert.match(checkRecord({...clean, contexts: []}, {rendering: true}).join(), /no webgpu context/);
    assert.match(checkRecord({...clean, contexts: ["2d", "webgpu"]}, {rendering: true}).join(), /non-WebGPU/);
    assert.match(checkRecord({...clean, validationErrors: [{message: "x"}]}, {rendering: true}).join(), /validation/);
    assert.match(checkRecord({...clean, rejections: ["x"]}, {rendering: false}).join(), /unhandled/);
    assert.match(checkRecord({...clean, errors: ["x"]}, {rendering: false}).join(), /uncaught/);
    assert.deepEqual(checkRecord({...clean, contexts: []}, {rendering: false}), []);
});

test("a rejection never counts as a rendering pass, and not-run is not success", () => {
    assert.equal(classify({kind: "render"}), "pass");
    assert.equal(classify({kind: "rejection"}), "rejection-pass");
    assert.equal(classify({kind: "rejection", problems: ["x"]}), "fail");
    assert.equal(classify({kind: "render", ran: false}), "not-run");
    assert.equal(summarize([{result: "pass"}, {result: "not-run"}]).ok, false);
    assert.equal(summarize([]).ok, false);
    assert.equal(summarize([{result: "rejection-pass"}]).ok, true);
});

test("the software lane requires a fallback adapter", () => {
    assert.deepEqual(planLane("software", {api: true, adapter: {isFallbackAdapter: true}}).problems, []);
    assert.match(planLane("software", {api: true, adapter: {isFallbackAdapter: false}}).problems.join(), /not a fallback/);
    assert.match(planLane("software", {api: true, adapter: null}).problems.join(), /no adapter/);
    assert.match(planLane("software", {api: false, adapter: null}).problems.join(), /no WebGPU API/);
    assert.equal(planLane("software", {api: true, adapter: {isFallbackAdapter: true}}).cases.length, 12);
});

test("observation lanes do not require a missing GPU", () => {
    assert.equal(planLane("firefox-default", {api: false, adapter: null}).natural, "api-unavailable");
    assert.equal(planLane("chromium-default", {api: true, adapter: null}).natural, "adapter-unavailable");
    const found = planLane("chromium-default", {api: true, adapter: {isFallbackAdapter: false}});
    assert.equal(found.natural, null);
    assert.deepEqual(found.problems, []);
    assert.deepEqual(found.cases, ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "N1", "N2", "N3", "N4", "N5"]);
    assert.match(found.label, /not hardware qualification/);
    assert.throws(() => planLane("hardware", {api: true, adapter: null}), /Unknown lane/);
});

function fakeBrowser() {
    const listeners = [];
    const device = {destroyed: false, addEventListener: (type, fn) => listeners.push({type, fn}),
        destroy() { this.destroyed = true; }};
    const adapterInfo = {vendor: "google", architecture: "swiftshader", isFallbackAdapter: true,
        device: "private device", description: "private description"};
    class GPUAdapter { constructor() { this.info = adapterInfo; } requestDevice() { return Promise.resolve(device); } }
    const adapter = new GPUAdapter();
    class GPU { requestAdapter() { return Promise.resolve(adapter); } }
    const gpu = new GPU();
    class Navigator {}
    Object.defineProperty(Navigator.prototype, "gpu", {get: () => gpu, configurable: true});
    class HTMLCanvasElement { getContext(type) { return {type}; } }
    const context = {Navigator, GPU, GPUAdapter, HTMLCanvasElement, navigator: new Navigator(),
        isSecureContext: true, Promise, Error, String, Object, addEventListener() {}};
    return {context, listeners, device};
}

function instrumentIn(context, inject) {
    runInNewContext("(" + instrument.toString() + ")(" + JSON.stringify({inject}) + ")", context);
    return context.__mqProofRecord;
}

test("instrumentation records contexts, adapters, devices, and validation errors", async () => {
    const {context, listeners, device} = fakeBrowser();
    const record = instrumentIn(context, null);
    new context.HTMLCanvasElement().getContext("webgpu");
    const adapter = await context.navigator.gpu.requestAdapter();
    assert.equal(await adapter.requestDevice(), device);
    assert.deepEqual([...record.contexts], ["webgpu"]);
    assert.equal(record.adapterRequests, 1);
    assert.equal(record.adapters[0].isFallbackAdapter, true);
    assert.equal(record.adapters[0].architecture, "swiftshader");
    assert.deepEqual(Object.keys(record.adapters[0]).sort(), ["architecture", "isFallbackAdapter", "vendor"]);
    assert.equal(context.__mqProofDevices[0], device);
    listeners.find(item => item.type === "uncapturederror").fn({error: {message: "bad bind group"}});
    assert.equal(record.validationErrors[0].message, "bad bind group");
});

test("injections are controlled by the harness, not the candidate", async () => {
    let browser = fakeBrowser();
    instrumentIn(browser.context, INJECTIONS.N1);
    assert.equal("gpu" in browser.context.navigator, false);

    browser = fakeBrowser();
    instrumentIn(browser.context, INJECTIONS.N2);
    assert.equal(browser.context.isSecureContext, false);

    browser = fakeBrowser();
    let record = instrumentIn(browser.context, INJECTIONS.N3);
    assert.equal(await browser.context.navigator.gpu.requestAdapter(), null);
    assert.equal(record.adapterRequests, 1);

    browser = fakeBrowser();
    record = instrumentIn(browser.context, INJECTIONS.N4);
    const adapter = await browser.context.navigator.gpu.requestAdapter();
    await assert.rejects(adapter.requestDevice(), /Injected device request failure/);
    assert.equal(record.deviceRequests, 1);
});

test("runner arguments select a candidate and a known lane", () => {
    assert.equal(parseArgs(["--candidate", "manual"]).port, 4294);
    assert.equal(parseArgs(["--candidate", "manual"]).headful, false);
    assert.equal(parseArgs(["--candidate", "manual", "--headful"]).headful, true);
    assert.equal(parseArgs(["--candidate", "wgpu", "--lane", "webkit-default"]).port, 4295);
    assert.throws(() => parseArgs(["--candidate", "webgl"]), /manual or wgpu/);
    assert.throws(() => parseArgs(["--candidate", "manual", "--lane", "fallback"]), /--lane/);
});

test("headful receipts do not overwrite headless receipts", () => {
    const options = parseArgs(["--candidate", "wgpu", "--lane", "chromium-default"]);
    assert.equal(receiptPath(options, "chromium"), resolve(options.out, "wgpu-chromium-default-chromium.json"));
    assert.equal(receiptPath({...options, headful: true}, "chromium"),
        resolve(options.out, "wgpu-chromium-default-chromium-headful.json"));
});

test("hardware observations distinguish failed runs from unqualified passing runs", () => {
    assert.equal(hardwareObservation(false, true), "NOT TESTED");
    assert.equal(hardwareObservation(false, false), "NOT TESTED");
    assert.equal(hardwareObservation(true, false), "OBSERVED, FAILED");
    assert.equal(hardwareObservation(true, true), "OBSERVED, NOT QUALIFIED");
});

test("server maps candidates to their dist folders and rejects other paths", () => {
    const folders = {manual: resolve("tests/webgpu-proof/fixtures/manual-dist")};
    assert.equal(resolveAsset("/manual/", folders), resolve(folders.manual, "index.html"));
    assert.equal(resolveAsset("/manual/../../secret", folders), null);
    assert.equal(resolveAsset("/manual/%2e%2e/%2e%2e/secret", folders), null);
    assert.equal(resolveAsset("/wgpu/index.html", folders), null);
    assert.equal(resolveAsset("/%ZZ", folders), null);
    assert.throws(() => checkPort(4292), /reserved/);
    assert.equal(checkPort(0), 0);
});

test("server sends WASM with the correct type and gives 404 for missing files", async (t) => {
    const server = createProofServer({folders: {manual: resolve("tests/webgpu-proof/fixtures/manual-dist")}});
    const port = await listen(server, 0);
    t.after(() => new Promise(done => server.close(done)));
    const base = "http://127.0.0.1:" + port;
    const wasm = await fetch(base + "/manual/empty.wasm");
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    assert.equal((await wasm.arrayBuffer()).byteLength, 8);
    assert.equal((await fetch(base + "/manual/index.html")).status, 200);
    assert.equal((await fetch(base + "/manual/missing.wasm")).status, 404);
    assert.equal((await fetch(base + "/health")).status, 200);
});

test("receipts accept only the exact repository-pinned Playwright version", () => {
    assert.equal(comparePlaywright("1.65.0", "1.65.0").matchesPin, true);
    assert.equal(comparePlaywright("1.65.0", "1.56.1").matchesPin, false);
    assert.equal(comparePlaywright("^1.65.0", "1.65.0").matchesPin, false);
    assert.equal(comparePlaywright("1.65.0", null).matchesPin, false);
});
