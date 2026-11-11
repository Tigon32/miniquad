#!/usr/bin/env node
// Shared browser runner for docs/webgpu-proof-contract.md, version 1.
// Usage: node tests/webgpu-proof/run-proof.mjs --candidate manual|wgpu --lane <lane> [--port N]
// It needs the built candidate in experiments/webgpu-<candidate>/dist/ and @playwright/test.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { arch, platform, release } from "node:os";
import {
    CANDIDATES, CONTRACT, INJECTED_CODES, KEY_CODE, LANES, POINTER, RESIZED, STOP_FRAMES, TERMINAL, VIEWPORT,
    checkProgress, checkReadback, checkRecord, checkRejection, classify, planLane, summarize, validateStatus,
} from "./contract.mjs";
import { INJECTIONS, instrument } from "./instrumentation.mjs";
import { DEFAULT_PORTS, HOST, createProofServer, defaultDistFolders, listen } from "../../scripts/webgpu-proof-serve.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STEP_TIMEOUT = Number(process.env.WEBGPU_PROOF_STEP_TIMEOUT_MS ?? 20000);

export function parseArgs(argv) {
    const options = {candidate: null, lane: "software", port: null, out: join(root, "target", "webgpu-proof")};
    for (let i = 0; i < argv.length; i += 1) {
        const value = argv[i + 1];
        if (argv[i] === "--candidate") { options.candidate = value; i += 1; }
        else if (argv[i] === "--lane") { options.lane = value; i += 1; }
        else if (argv[i] === "--port") { options.port = Number(value); i += 1; }
        else if (argv[i] === "--out") { options.out = resolve(value); i += 1; }
        else throw new Error("Unknown argument: " + argv[i]);
    }
    if (!CANDIDATES.includes(options.candidate)) throw new Error("--candidate must be manual or wgpu");
    if (!LANES[options.lane]) throw new Error("--lane must be one of " + Object.keys(LANES).join(", "));
    options.port ??= DEFAULT_PORTS[options.candidate];
    return options;
}

class CaseFailure extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// Wait in the page, on animation frames, until `spec` is true or a terminal phase is outside `spec.phases`.
function pageCondition(spec) {
    const host = globalThis.__mqWebGpuProof;
    if (!host || typeof host.status !== "function") return false;
    const s = host.status();
    const terminal = ["failed", "lost", "disposed"];
    if (terminal.includes(s.phase) && !(spec.phases || []).includes(s.phase)) return true;
    if (spec.phases && !spec.phases.includes(s.phase)) return false;
    if (spec.minFrames !== undefined && s.frameCount < spec.minFrames) return false;
    if (spec.readbackId !== undefined &&
        !(s.readback.id === spec.readbackId && (s.readback.state === "ready" || s.readback.state === "failed"))) {
        return false;
    }
    if (spec.surface && !(s.surface.width === spec.surface.width && s.surface.height === spec.surface.height)) {
        return false;
    }
    if (spec.minResizes !== undefined && s.resizeCount < spec.minResizes) return false;
    if (spec.keyCode !== undefined && !(s.input.key && s.input.key.code === spec.keyCode && !s.input.key.down)) {
        return false;
    }
    if (spec.pointer && !(s.input.pointer && s.input.pointer.x === spec.pointer.x &&
        s.input.pointer.y === spec.pointer.y && s.input.pointer.button === spec.pointer.button)) {
        return false;
    }
    if (spec.focused !== undefined && s.input.focused !== spec.focused) return false;
    if (spec.minFocusChanges !== undefined && s.input.focusChanges < spec.minFocusChanges) return false;
    return true;
}

class ProofPage {
    constructor(page, candidate, mode) {
        this.page = page;
        this.candidate = candidate;
        this.mode = mode;
        this.last = null;
        this.pageErrors = [];
        page.on("pageerror", error => this.pageErrors.push(String(error.message || error)));
    }

    async status() {
        const status = await this.page.evaluate(() => {
            const host = globalThis.__mqWebGpuProof;
            return host && typeof host.status === "function" ? host.status() : null;
        });
        if (status === null) throw new CaseFailure("host object __mqWebGpuProof is missing", null);
        const problems = [...validateStatus(status, {candidate: this.candidate, mode: this.mode}),
            ...checkProgress(this.last, status)];
        this.last = status;
        if (problems.length) throw new CaseFailure("status violates the contract: " + problems.join("; "), status);
        return status;
    }

    async waitFor(spec, what) {
        try {
            await this.page.waitForFunction(pageCondition, spec, {polling: "raf", timeout: STEP_TIMEOUT});
        } catch (error) {
            const status = await this.page.evaluate(() => globalThis.__mqWebGpuProof?.status?.() ?? null)
                .catch(() => null);
            throw new CaseFailure("deadline for " + what + " (" + STEP_TIMEOUT + " ms): " + error.message.split("\n")[0], status);
        }
        const status = await this.status();
        if (TERMINAL.includes(status.phase) && !(spec.phases || []).includes(status.phase)) {
            throw new CaseFailure("unexpected terminal phase " + status.phase + " while waiting for " + what +
                (status.error ? " (" + status.error.code + ": " + status.error.message + ")" : ""), status);
        }
        return status;
    }

    async animationFrames(count) {
        await this.page.evaluate(n => new Promise(done => {
            let left = n;
            const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
            requestAnimationFrame(step);
        }), count);
    }

    // Prove that frame submission stopped: frameCount is equal before and after three animation frames.
    async framesStopped() {
        const before = (await this.status()).frameCount;
        await this.animationFrames(STOP_FRAMES);
        const after = (await this.status()).frameCount;
        if (after !== before) throw new CaseFailure("frameCount changed from " + before + " to " + after, this.last);
    }

    async readback(size) {
        const id = await this.page.evaluate(() => globalThis.__mqWebGpuProof.requestReadback());
        if (!Number.isInteger(id) || id <= 0) throw new CaseFailure("requestReadback returned " + id, this.last);
        const status = await this.waitFor({phases: ["running"], readbackId: id}, "readback " + id);
        const problems = checkReadback(status, id, size);
        if (problems.length) throw new CaseFailure("readback: " + problems.join("; "), status);
        return status.readback;
    }

    async record() {
        const record = await this.page.evaluate(() => globalThis.__mqProofRecord ?? null);
        if (!record) throw new CaseFailure("instrumentation record is missing", this.last);
        return {...record, errors: [...record.errors, ...this.pageErrors]};
    }
}

async function openPage(context, options, {mode = "render", inject = null, blockWasm = false} = {}) {
    const page = await context.newPage();
    await page.addInitScript(instrument, {inject});
    if (blockWasm) await page.route("**/*.wasm", route => route.fulfill({status: 404, body: "Not found"}));
    const proof = new ProofPage(page, options.candidate, mode);
    const started = performance.now();
    await page.goto("http://" + HOST + ":" + options.port + "/" + options.candidate + "/index.html?mode=" + mode);
    await page.waitForFunction(() => Boolean(globalThis.__mqWebGpuProof), null, {timeout: STEP_TIMEOUT});
    const host = await page.evaluate(() => ({
        contract: globalThis.__mqWebGpuProof.contract,
        candidate: globalThis.__mqWebGpuProof.candidate,
        secure: globalThis.isSecureContext,
        api: "gpu" in navigator && Boolean(navigator.gpu),
    }));
    if (host.contract !== CONTRACT || host.candidate !== options.candidate) {
        throw new CaseFailure("host object identity is wrong: " + JSON.stringify(host), null);
    }
    return {page, proof, started, host};
}

async function runCase(id, kind, body) {
    const begin = performance.now();
    let problems = [];
    let status = null;
    let extra = {};
    try {
        const out = await body();
        problems = out.problems ?? [];
        status = out.status ?? null;
        extra = out.extra ?? {};
    } catch (error) {
        problems = [error.message];
        status = error.status ?? null;
    }
    const result = classify({kind, problems});
    return {id, kind, result, problems, lastStatus: status, ms: Math.round(performance.now() - begin), ...extra};
}

async function finish(open, rendering, problems, status) {
    const record = await open.proof.record();
    await open.page.close();
    return {problems: [...problems, ...checkRecord(record, {rendering})], status, extra: {record}};
}

async function renderSequence(context, options, samples) {
    const results = [];
    let open;
    try {
        open = await openPage(context, options);
    } catch (error) {
        for (const id of ["T1", "T2", "T3", "T4", "T5"]) {
            results.push({id, kind: "render", result: "fail", problems: [error.message], lastStatus: error.status ?? null});
        }
        return results;
    }
    const {proof, page} = open;
    let broken = null;
    const step = async (id, body) => {
        if (broken) {
            results.push({id, kind: "render", result: "fail", problems: ["not reached: " + broken], lastStatus: proof.last});
            return;
        }
        const result = await runCase(id, "render", async () => {
            const status = await body();
            const record = await proof.record();
            return {problems: checkRecord(record, {rendering: true}), status, extra: {}};
        });
        results.push(result);
        if (result.result !== "pass") broken = id;
    };

    await step("T1", async () => {
        const running = await proof.waitFor({phases: ["running"]}, "running");
        samples.push(Math.round(performance.now() - open.started));
        if (running.reporter !== "rust") throw new CaseFailure("running status must come from Rust", running);
        if (running.surface.width !== VIEWPORT.width || running.surface.height !== VIEWPORT.height) {
            throw new CaseFailure("surface is not " + VIEWPORT.width + "x" + VIEWPORT.height, running);
        }
        await proof.waitFor({phases: ["running"], minFrames: running.frameCount + 2}, "frames");
        await proof.readback(VIEWPORT);
        return proof.last;
    });
    await step("T2", async () => {
        const before = await proof.status();
        await page.setViewportSize(RESIZED);
        await proof.waitFor({phases: ["running"], surface: RESIZED, minResizes: before.resizeCount + 1}, "resize");
        await proof.readback(RESIZED);
        return proof.last;
    });
    await step("T3", async () => {
        await page.mouse.click(POINTER.x, POINTER.y, {button: POINTER.button});
        await page.keyboard.press(KEY_CODE);
        return proof.waitFor({phases: ["running"], pointer: POINTER, keyCode: KEY_CODE}, "input");
    });
    await step("T4", async () => {
        await page.evaluate(() => document.getElementById("mq-proof-canvas").blur());
        await proof.waitFor({phases: ["running"], focused: false}, "initial blur");
        const start = (await proof.status()).input.focusChanges;
        await page.focus("#mq-proof-canvas");
        await proof.waitFor({phases: ["running"], focused: true}, "focus");
        await page.evaluate(() => document.getElementById("mq-proof-canvas").blur());
        return proof.waitFor({phases: ["running"], focused: false, minFocusChanges: start + 2}, "blur");
    });
    await step("T5", async () => {
        await page.evaluate(() => {
            globalThis.__mqWebGpuProof.dispose();
            globalThis.__mqWebGpuProof.dispose();
        });
        const disposed = await proof.waitFor({phases: ["disposed"]}, "disposed");
        if (disposed.phase !== "disposed") throw new CaseFailure("phase is " + disposed.phase, disposed);
        await proof.framesStopped();
        const input = JSON.stringify(disposed.input);
        await page.mouse.click(POINTER.x + 10, POINTER.y + 10);
        await page.keyboard.press("KeyB");
        await proof.animationFrames(STOP_FRAMES);
        const after = await proof.status();
        if (JSON.stringify(after.input) !== input) throw new CaseFailure("input changed after dispose", after);
        return after;
    });
    await page.close();
    return results;
}

async function deviceLossCase(context, options, samples) {
    return runCase("T6", "render", async () => {
        const open = await openPage(context, options);
        const running = await open.proof.waitFor({phases: ["running"]}, "running");
        samples.push(Math.round(performance.now() - open.started));
        await open.proof.waitFor({phases: ["running"], minFrames: running.frameCount + 1}, "frames");
        const count = await open.page.evaluate(() => globalThis.__mqProofDevices.length);
        if (count !== 1) throw new CaseFailure("expected one recorded device, found " + count, running);
        await open.page.evaluate(() => globalThis.__mqProofDevices[0].destroy());
        const lost = await open.proof.waitFor({phases: ["lost"]}, "device loss");
        const problems = [];
        if (lost.error?.code !== "device-lost") problems.push("code is " + lost.error?.code);
        if (lost.error?.reason !== "destroyed") problems.push("reason is " + lost.error?.reason);
        await open.proof.framesStopped();
        const record = await open.proof.record();
        await open.page.close();
        return {problems: [...problems, ...checkRecord(record, {rendering: true})], status: lost};
    });
}

async function rejectionCase(context, options, id, code, openOptions) {
    return runCase(id, "rejection", async () => {
        const open = await openPage(context, options, openOptions);
        const status = await open.proof.waitFor({phases: ["failed"]}, code);
        const problems = checkRejection(status, code);
        if (code === "insecure-context") {
            const record = await open.proof.record();
            if (record.adapterRequests !== 0) problems.push("adapter was requested " + record.adapterRequests + " times");
        }
        return finish(open, false, problems, status);
    });
}

function artifactSizes(candidate) {
    const folder = defaultDistFolders(root)[candidate];
    const files = [];
    const walk = dir => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(?:wasm|m?js)$/u.test(name)) {
                const data = readFileSync(path);
                files.push({file: relative(root, path), raw: data.byteLength,
                    gzip: gzipSync(data, {level: 9}).byteLength, brotli: brotliCompressSync(data).byteLength});
            }
        }
    };
    walk(folder);
    return files;
}

export function comparePlaywright(pinned, installed) {
    const exact = typeof pinned === "string" && /^\d+\.\d+\.\d+$/u.test(pinned);
    return {pinned: pinned ?? null, installed: installed ?? null, matchesPin: exact && pinned === installed};
}

function readVersion(file) {
    try { return JSON.parse(readFileSync(file, "utf8")).version ?? null; } catch { return null; }
}

function playwrightState() {
    let pinned = null;
    try {
        pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.["@playwright/test"] ?? null;
    } catch { pinned = null; }
    let installed = null;
    for (let dir = root; !installed; dir = dirname(dir)) {
        installed = readVersion(join(dir, "node_modules", "@playwright", "test", "package.json"));
        if (dirname(dir) === dir) break;
    }
    return comparePlaywright(pinned, installed);
}

function sourceState() {
    try {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
        const dirty = execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim().length > 0;
        return {sha, dirty};
    } catch {
        return {sha: null, dirty: null};
    }
}

export async function runLane(options) {
    const lane = LANES[options.lane];
    const playwright = await import("@playwright/test");
    const server = createProofServer();
    await listen(server, options.port);
    const browser = await playwright[lane.browser].launch({headless: true, args: [...lane.flags]});
    const receipt = {
        contract: CONTRACT, candidate: options.candidate, lane: options.lane, checkedAt: new Date().toISOString(),
        source: sourceState(), os: {platform: platform(), release: release(), arch: arch()},
        node: process.version, browser: {name: lane.browser, version: browser.version(), flags: [...lane.flags]},
        playwright: playwrightState(), hardware: "NOT TESTED", results: [], startupMs: [],
    };
    if (!receipt.playwright.matchesPin) {
        receipt.results.push({id: "toolchain", kind: "render", result: "fail", lastStatus: null,
            problems: ["installed Playwright " + receipt.playwright.installed + " does not match pin " +
                receipt.playwright.pinned]});
    }
    try {
        const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1});
        const probe = await openPage(context, options);
        const first = await probe.proof.waitFor({phases: ["running", "failed"]}, "first observation")
            .catch(error => error.status);
        const record = await probe.proof.record();
        await probe.page.close();
        const adapter = record.adapters.find(item => item) ?? null;
        receipt.secureContext = probe.host.secure;
        receipt.observation = {api: probe.host.api, adapter, firstPhase: first?.phase ?? null,
            firstError: first?.error ?? null};
        const plan = planLane(options.lane, {api: probe.host.api, adapter});
        receipt.label = plan.label;
        receipt.planProblems = plan.problems;
        if (plan.problems.length) {
            receipt.results.push({id: "lane", kind: "render", result: "fail", problems: plan.problems,
                lastStatus: first ?? null});
        }
        if (plan.natural) {
            receipt.results.push(await rejectionCase(context, options, "R-" + plan.natural, plan.natural, {}));
        }
        if (!plan.problems.length && plan.cases.length) {
            receipt.results.push(...await renderSequence(context, options, receipt.startupMs));
            receipt.results.push(await deviceLossCase(context, options, receipt.startupMs));
            receipt.results.push(await rejectionCase(context, options, "T7", "shader-compilation",
                {mode: "invalid-wgsl"}));
            for (const id of plan.cases.filter(name => name.startsWith("N"))) {
                const openOptions = id === "N5" ? {blockWasm: true} : {inject: INJECTIONS[id]};
                receipt.results.push(await rejectionCase(context, options, id, INJECTED_CODES[id], openOptions));
            }
        }
        await context.close();
    } finally {
        await browser.close();
        await new Promise(done => server.close(done));
    }
    try { receipt.artifacts = artifactSizes(options.candidate); }
    catch (error) { receipt.artifacts = {error: error.message}; }
    receipt.summary = summarize(receipt.results);
    return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = parseArgs(process.argv.slice(2));
    const receipt = await runLane(options);
    mkdirSync(options.out, {recursive: true});
    const file = join(options.out, options.candidate + "-" + options.lane + "-" + receipt.browser.name + ".json");
    writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
    for (const result of receipt.results) {
        console.log(result.id.padEnd(22) + result.result.padEnd(16) + (result.problems[0] ?? ""));
    }
    console.log("Label: " + receipt.label + "; hardware: NOT TESTED; receipt: " + relative(root, file));
    if (!receipt.summary.ok) process.exitCode = 1;
}
