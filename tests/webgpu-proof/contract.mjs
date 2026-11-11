// The single oracle for docs/webgpu-proof-contract.md, version 1.
// This module has no browser or Playwright dependency, so unit tests can check it.

export const CONTRACT = "miniquad-webgpu-proof/1";
export const CANDIDATES = Object.freeze(["manual", "wgpu"]);
export const MODES = Object.freeze(["render", "invalid-wgsl"]);
export const PHASES = Object.freeze(["loading", "starting", "running", "failed", "lost", "disposed"]);
export const TERMINAL = Object.freeze(["failed", "lost", "disposed"]);
export const ERROR_CODES = Object.freeze([
    "api-unavailable", "insecure-context", "adapter-unavailable", "device-request-failed",
    "canvas-context-unavailable", "shader-compilation", "pipeline-creation", "readback-failed",
    "device-lost", "not-running", "wasm-load-failed", "contract-mismatch", "internal",
]);
export const HOST_CODES = Object.freeze(["wasm-load-failed", "contract-mismatch"]);
export const FORMATS = Object.freeze(["bgra8unorm", "rgba8unorm"]);
export const BUTTONS = Object.freeze(["left", "middle", "right"]);
export const MAX_MESSAGE_BYTES = 4096;

export const VIEWPORT = Object.freeze({width: 256, height: 256});
export const RESIZED = Object.freeze({width: 320, height: 200});
export const CENTER_RGBA = Object.freeze([255, 0, 0, 255]);
export const CORNER_RGBA = Object.freeze([0, 0, 255, 255]);
export const POINTER = Object.freeze({x: 40, y: 30, button: "left"});
export const KEY_CODE = "KeyA";
export const STOP_FRAMES = 3;

export const SOFTWARE_FLAGS = Object.freeze([
    "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
]);

export const LANES = Object.freeze({
    "software": {browser: "chromium", flags: SOFTWARE_FLAGS, requireFallbackAdapter: true,
        label: "software adapter"},
    "chromium-default": {browser: "chromium", flags: [], observation: true, label: "observation"},
    "firefox-default": {browser: "firefox", flags: [], observation: true, label: "observation"},
    "webkit-default": {browser: "webkit", flags: [], observation: true, label: "observation"},
});

export const RENDER_CASES = Object.freeze(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
export const INJECTED_CASES = Object.freeze(["N1", "N2", "N3", "N4", "N5"]);
export const INJECTED_CODES = Object.freeze({
    N1: "api-unavailable", N2: "insecure-context", N3: "adapter-unavailable",
    N4: "device-request-failed", N5: "wasm-load-failed",
});
export const RESULTS = Object.freeze(["pass", "rejection-pass", "fail", "not-run"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = value => Number.isInteger(value) && value >= 0;
const isRgba = value => Array.isArray(value) && value.length === 4 &&
    value.every(n => Number.isInteger(n) && n >= 0 && n <= 255);

function checkError(error, path, problems) {
    if (!isObject(error)) {
        problems.push(path + " must be an object or null");
        return;
    }
    if (!ERROR_CODES.includes(error.code)) problems.push(path + ".code is not a contract code: " + error.code);
    if (typeof error.message !== "string" || error.message.length === 0) {
        problems.push(path + ".message must be a non-empty string");
    } else if (new TextEncoder().encode(error.message).byteLength > MAX_MESSAGE_BYTES) {
        problems.push(path + ".message is longer than " + MAX_MESSAGE_BYTES + " bytes");
    }
    if (error.reason !== undefined) {
        if (error.code !== "device-lost") problems.push(path + ".reason is only for device-lost");
        else if (!["destroyed", "unknown"].includes(error.reason)) problems.push(path + ".reason is invalid");
    }
}

// Return a list of contract violations. An empty list means the status has the contract shape.
export function validateStatus(status, expected = {}) {
    const problems = [];
    if (!isObject(status)) return ["status must be an object"];
    if (status.contract !== CONTRACT) problems.push("contract must be " + CONTRACT);
    if (!CANDIDATES.includes(status.candidate)) problems.push("candidate is invalid");
    if (expected.candidate && status.candidate !== expected.candidate) problems.push("candidate differs");
    if (!["host", "rust"].includes(status.reporter)) problems.push("reporter is invalid");
    if (!MODES.includes(status.mode)) problems.push("mode is invalid");
    if (expected.mode && status.mode !== expected.mode) problems.push("mode differs");
    if (!PHASES.includes(status.phase)) problems.push("phase is invalid: " + status.phase);
    if (status.error === null) {
        if (status.phase === "failed" || status.phase === "lost") problems.push(status.phase + " needs an error");
    } else {
        checkError(status.error, "error", problems);
        if (isObject(status.error)) {
            if (status.reporter === "host" && !HOST_CODES.includes(status.error.code)) {
                problems.push("host cannot report " + status.error.code);
            }
            if (status.phase === "lost" && status.error.code !== "device-lost") problems.push("lost needs device-lost");
        }
    }
    if (status.reporter === "host" && !["loading", "failed"].includes(status.phase)) {
        problems.push("host can report only loading or failed");
    }
    if (status.canvasFormat !== null && !FORMATS.includes(status.canvasFormat)) problems.push("canvasFormat is invalid");
    if (!isObject(status.surface) || !isCount(status.surface.width) || !isCount(status.surface.height)) {
        problems.push("surface must have integer width and height");
    }
    if (!isCount(status.frameCount)) problems.push("frameCount must be a count");
    if (!isCount(status.resizeCount)) problems.push("resizeCount must be a count");
    const input = status.input;
    if (!isObject(input)) problems.push("input must be an object");
    else {
        const p = input.pointer;
        if (p !== null && (!isObject(p) || typeof p.x !== "number" || typeof p.y !== "number" ||
            !BUTTONS.includes(p.button) || typeof p.down !== "boolean")) problems.push("input.pointer is invalid");
        const k = input.key;
        if (k !== null && (!isObject(k) || typeof k.code !== "string" || typeof k.down !== "boolean")) {
            problems.push("input.key is invalid");
        }
        if (typeof input.focused !== "boolean") problems.push("input.focused must be boolean");
        if (!isCount(input.focusChanges)) problems.push("input.focusChanges must be a count");
    }
    const r = status.readback;
    if (!isObject(r)) problems.push("readback must be an object");
    else {
        if (!isCount(r.id)) problems.push("readback.id must be a count");
        if (!["idle", "pending", "ready", "failed"].includes(r.state)) problems.push("readback.state is invalid");
        if (!isCount(r.width) || !isCount(r.height)) problems.push("readback size must be counts");
        for (const key of ["center", "corner"]) {
            if (r[key] !== null && !isRgba(r[key])) problems.push("readback." + key + " must be RGBA bytes or null");
        }
        if (r.state === "ready" && (!isRgba(r.center) || !isRgba(r.corner))) problems.push("ready readback needs pixels");
        if (r.state === "failed") {
            if (r.error === null || r.error === undefined) problems.push("failed readback needs an error");
            else checkError(r.error, "readback.error", problems);
        } else if (r.error !== null) problems.push("readback.error must be null unless failed");
    }
    return problems;
}

// Check a later status against an earlier status from the same page.
export function checkProgress(previous, next) {
    const problems = [];
    if (!previous || !next) return problems;
    if (TERMINAL.includes(previous.phase) && next.phase !== previous.phase) {
        problems.push("terminal phase " + previous.phase + " changed to " + next.phase);
    }
    if (next.frameCount < previous.frameCount) problems.push("frameCount decreased");
    if (next.resizeCount < previous.resizeCount) problems.push("resizeCount decreased");
    if (TERMINAL.includes(previous.phase) && next.frameCount !== previous.frameCount) {
        problems.push("frameCount changed after terminal phase");
    }
    return problems;
}

export function pixelPositions(width, height) {
    return {center: [Math.floor(width / 2), Math.floor(height / 2)], corner: [0, 0]};
}

function sameRgba(actual, expected) {
    return Array.isArray(actual) && actual.length === 4 && actual.every((v, i) => v === expected[i]);
}

export function checkReadback(status, id, size) {
    const problems = [];
    const r = status?.readback;
    if (!r) return ["no readback"];
    if (r.id !== id) problems.push("readback id " + r.id + " is not " + id);
    if (r.state !== "ready") {
        problems.push("readback state is " + r.state + (r.error ? " (" + r.error.code + ")" : ""));
    }
    if (r.width !== size.width || r.height !== size.height) {
        problems.push("readback size " + r.width + "x" + r.height + " is not " + size.width + "x" + size.height);
    }
    if (!sameRgba(r.center, CENTER_RGBA)) {
        problems.push("center " + JSON.stringify(r.center) + " is not " + JSON.stringify(CENTER_RGBA));
    }
    if (!sameRgba(r.corner, CORNER_RGBA)) {
        problems.push("corner " + JSON.stringify(r.corner) + " is not " + JSON.stringify(CORNER_RGBA));
    }
    return problems;
}

export function checkRejection(status, code) {
    const reporter = HOST_CODES.includes(code) ? "host" : "rust";
    const problems = [];
    if (status?.phase !== "failed") problems.push("phase is " + status?.phase + ", not failed");
    if (status?.error?.code !== code) problems.push("error code is " + status?.error?.code + ", not " + code);
    if (status?.reporter !== reporter) problems.push("reporter is " + status?.reporter + ", not " + reporter);
    if (status?.frameCount !== 0) problems.push("frameCount is " + status?.frameCount + ", not 0");
    return problems;
}

// Checks that apply to every case. `record` is the instrumentation record from the page.
export function checkRecord(record, {rendering}) {
    const problems = [];
    const contexts = record?.contexts ?? [];
    const webgl = contexts.filter(type => /webgl/iu.test(String(type)));
    if (webgl.length) problems.push("WebGL context requested: " + webgl.join(", "));
    if (rendering) {
        const other = contexts.filter(type => type !== "webgpu");
        if (other.length) problems.push("non-WebGPU context requested: " + other.join(", "));
        if (!contexts.includes("webgpu")) problems.push("no webgpu context requested");
        if (record?.validationErrors?.length) {
            problems.push("validation errors: " + JSON.stringify(record.validationErrors.slice(0, 3)));
        }
    }
    if (record?.rejections?.length) problems.push("unhandled rejections: " + JSON.stringify(record.rejections.slice(0, 3)));
    if (record?.errors?.length) problems.push("uncaught errors: " + JSON.stringify(record.errors.slice(0, 3)));
    return problems;
}

// A case result. A rejection case never counts as a rendering pass.
export function classify({kind, ran = true, problems = []}) {
    if (!ran) return "not-run";
    if (problems.length) return "fail";
    return kind === "rejection" ? "rejection-pass" : "pass";
}

// Decide what a lane runs after the first page gives its observation.
// `observation` is {api: boolean, adapter: null | {isFallbackAdapter}}.
export function planLane(laneName, observation) {
    const lane = LANES[laneName];
    if (!lane) throw new Error("Unknown lane: " + laneName);
    if (!lane.observation) {
        const problems = [];
        if (!observation.api) problems.push("software lane has no WebGPU API");
        else if (!observation.adapter) problems.push("software lane has no adapter");
        else if (lane.requireFallbackAdapter && observation.adapter.isFallbackAdapter !== true) {
            problems.push("software lane adapter is not a fallback adapter");
        }
        return {cases: [...RENDER_CASES, ...INJECTED_CASES], natural: null, problems, label: lane.label};
    }
    if (!observation.api) return {cases: [], natural: "api-unavailable", problems: [], label: lane.label};
    if (!observation.adapter) return {cases: [], natural: "adapter-unavailable", problems: [], label: lane.label};
    const label = observation.adapter.isFallbackAdapter === true ? "software adapter (observed)"
        : "adapter observed, not hardware qualification";
    return {cases: [...RENDER_CASES], natural: null, problems: [], label};
}

export function summarize(results) {
    const counts = Object.fromEntries(RESULTS.map(name => [name, 0]));
    for (const result of results) counts[result.result] += 1;
    return {counts, ok: counts.fail === 0 && counts["not-run"] === 0 && results.length > 0};
}
