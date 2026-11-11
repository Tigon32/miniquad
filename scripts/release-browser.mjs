#!/usr/bin/env node
// Browser rollout/rollback exercise and regression guard for issue #19.
// Implements sections 6 and 7 of docs/release-candidate-contract.md.
//
// Pure functions (median, nearestRank, medianConfidenceRanks,
// clockResolution, evaluateMetric, createReleaseServer) use only Node.js
// builtin modules and have no third-party or network dependency, so the
// hermetic unit lane (tests/release-candidate.test.mjs, run before
// `npm ci` in CI) can import this file safely. The `drill` and `measure`
// commands additionally need Playwright; they import it lazily (dynamic
// `import()`), only when actually invoked, never at module load time.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

// ---------------------------------------------------------------------
// Statistics (section 7.5, exported pure functions)
// ---------------------------------------------------------------------

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Value at 1-based rank ceil(p * n) of an already-sorted array. */
export function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function binomialCdf(k, n, p = 0.5) {
  // Exact CDF via summed binomial PMF; n stays small (sample counts),
  // so a direct sum avoids floating overflow concerns from large powers.
  let sum = 0;
  let term = (1 - p) ** n; // P(X = 0)
  sum += term;
  for (let i = 1; i <= k; i += 1) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * Largest k with P(Binomial(n, 0.5) <= k - 1) <= alpha / 2. Returns
 * {low: k, high: n - k + 1, coverage}, the distribution-free confidence
 * interval for the median at 1-based ranks.
 */
export function medianConfidenceRanks(n, alpha = 0.05) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`medianConfidenceRanks requires a positive integer n, got: ${n}`);
  }
  let k = 0;
  for (let candidate = 1; candidate <= Math.floor(n / 2); candidate += 1) {
    if (binomialCdf(candidate - 1, n) <= alpha / 2) {
      k = candidate;
    } else {
      break;
    }
  }
  if (k === 0) k = 1;
  const high = n - k + 1;
  const coverage = 1 - 2 * binomialCdf(k - 1, n);
  return { low: k, high, coverage };
}

/**
 * Smallest positive difference between consecutive `performance.now()`
 * readings. Never returns 0; returns null if no positive difference
 * exists (for example, a single sample or an unexpectedly frozen clock).
 */
export function clockResolution(samples) {
  let smallest = null;
  for (const series of samples ?? []) {
    for (let i = 1; i < series.length; i += 1) {
      const diff = series[i] - series[i - 1];
      if (diff > 0 && (smallest === null || diff < smallest)) {
        smallest = diff;
      }
    }
  }
  return smallest;
}

/**
 * Section 7.5 rule for one gated metric and engine. `baseline` and
 * `candidate` are arrays of valid sample values; `resolution` is a
 * positive number or null (section 7.5 item 2: a null resolution is
 * always INCONCLUSIVE, never treated as zero).
 */
export function evaluateMetric({ baseline, candidate, resolution }) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate) || baseline.length < 20 || candidate.length < 20) {
    return { result: "INCONCLUSIVE", reason: "fewer than 20 valid values", limit: null, ciLow: null, ciHigh: null };
  }
  if ([...baseline, ...candidate].some((value) => !Number.isFinite(value) || value < 0)) {
    return { result: "INCONCLUSIVE", reason: "invalid sample value", limit: null, ciLow: null, ciHigh: null };
  }
  if (!Number.isFinite(resolution) || !(resolution > 0)) {
    return { result: "INCONCLUSIVE", reason: "clock resolution is null or not positive", limit: null, ciLow: null, ciHigh: null };
  }
  const sortedBaseline = [...baseline].sort((a, b) => a - b);
  const sortedCandidate = [...candidate].sort((a, b) => a - b);
  const limit = nearestRank(sortedBaseline, 0.9) + resolution;
  const { low, high } = medianConfidenceRanks(sortedCandidate.length);
  const ciLow = sortedCandidate[low - 1];
  const ciHigh = sortedCandidate[high - 1];
  let result;
  if (ciHigh <= limit) result = "PASS";
  else if (ciLow > limit) result = "FAIL";
  else result = "INCONCLUSIVE";
  const baselineMedian = median(baseline);
  const candidateMedian = median(candidate);
  return {
    result,
    reason: null,
    limit,
    ciLow,
    ciHigh,
    medianBaseline: baselineMedian,
    medianCandidate: candidateMedian,
    deltaMs: candidateMedian - baselineMedian,
    deltaPercent: baselineMedian === 0 ? null : Number((((candidateMedian - baselineMedian) * 100) / baselineMedian).toFixed(3)),
  };
}

// ---------------------------------------------------------------------
// section 6.1 server
// ---------------------------------------------------------------------

function safeJoin(root, name) {
  if (name.includes("..") || name.includes("\0")) return null;
  return join(root, name);
}

/**
 * `packages` maps a fixed name (for example "baseline", "candidate") to
 * `{dir}`, a prepared package directory with `payload/` and a canonical
 * `MANIFEST.json`. The server serves only files the active canonical
 * manifest lists, plus MANIFEST.json itself, under `/app/`. Fixed
 * mappings `/measure/baseline/` and `/measure/candidate/` always serve
 * those named packages regardless of the active deployment.
 */
export function createReleaseServer({ packages }) {
  let active = null;
  const loaded = new Map();

  function loadPackage(name) {
    if (loaded.has(name)) return loaded.get(name);
    const pkg = packages[name];
    if (!pkg) return null;
    const payloadDir = join(pkg.dir, "payload");
    const manifest = JSON.parse(readFileSync(join(payloadDir, "MANIFEST.json"), "utf8"));
    const files = new Map();
    for (const entry of manifest.files) {
      files.set(entry.file, { path: join(payloadDir, entry.file), sha256: entry.sha256 });
    }
    files.set("MANIFEST.json", { path: join(payloadDir, "MANIFEST.json"), sha256: createHash("sha256").update(readFileSync(join(payloadDir, "MANIFEST.json"))).digest("hex") });
    const record = { manifest, files };
    loaded.set(name, record);
    return record;
  }

  function sendFile(req, res, record, fileName) {
    const entry = record.files.get(fileName);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const etag = `"sha256-${entry.sha256}"`;
    const headers = {
      "Cache-Control": "no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Type": CONTENT_TYPES[fileName.slice(fileName.lastIndexOf("."))] || "application/octet-stream",
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(entry.path));
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname.includes("%2f") || pathname.includes("%2F") || pathname.includes("..")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    let match;
    if ((match = /^\/app\/?(.*)$/u.exec(pathname))) {
      if (!active) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("no package deployed");
        return;
      }
      const record = loadPackage(active);
      const fileName = match[1] || "index.html";
      sendFile(req, res, record, fileName);
      return;
    }
    if ((match = /^\/measure\/(baseline|candidate)\/?(.*)$/u.exec(pathname))) {
      const record = loadPackage(match[1]);
      if (!record) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      sendFile(req, res, record, match[2] || "index.html");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        deploy(name) {
          if (!packages[name]) throw new Error(`Unknown package: ${name}`);
          active = name;
          loadPackage(name);
        },
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------
// Playwright-backed helpers. Loaded lazily; never imported at module
// scope, so importing this file for its pure functions never requires
// Playwright to be installed.
// ---------------------------------------------------------------------

// Node's ESM loader does not reliably expose a CommonJS package's named
// exports as live bindings (it depends on static analysis of the
// package's module shape). `playwright`'s `index.js` sets
// `module.exports = {...}`, so after `import()` the engines are only
// guaranteed to be reachable via the namespace's `default` property, not
// as top-level named exports. Normalize to whichever shape has them.
function normalizePlaywrightModule(namespace) {
  if (namespace && typeof namespace.chromium === "object") return namespace;
  if (namespace && namespace.default && typeof namespace.default.chromium === "object") return namespace.default;
  throw new Error("Loaded module does not look like the playwright package (no chromium/firefox/webkit export).");
}

// Same reasoning as `loadPlaywright`: `pngjs` is only needed to decode a
// canvas screenshot into raw pixels for the drill's pixel assertions
// (section 6.2), so it is loaded lazily and only from the drill command
// path, never at module scope.
async function loadPngjs(env = process.env) {
  if (env.MINIQUAD_PNGJS_ENTRY && existsSync(env.MINIQUAD_PNGJS_ENTRY)) {
    const mod = await import(pathToFileURL(env.MINIQUAD_PNGJS_ENTRY).href);
    return mod.PNG ?? mod.default?.PNG;
  }
  const local = resolve(REPO_ROOT, "node_modules/pngjs/lib/png.js");
  if (existsSync(local)) {
    const mod = await import(pathToFileURL(local).href);
    return mod.PNG ?? mod.default?.PNG;
  }
  const parent = dirname(REPO_ROOT);
  const siblings = readdirSync(parent).sort((a, b) => (a === "miniquad" ? -1 : b === "miniquad" ? 1 : 0));
  for (const name of siblings) {
    const candidate = resolve(parent, name, "node_modules/pngjs/lib/png.js");
    if (candidate !== local && existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.PNG ?? mod.default?.PNG;
    }
  }
  throw new Error("pngjs not found locally or in a sibling worktree. Set MINIQUAD_PNGJS_ENTRY.");
}

async function loadPlaywright(env = process.env) {
  if (env.MINIQUAD_PLAYWRIGHT_ENTRY && existsSync(env.MINIQUAD_PLAYWRIGHT_ENTRY)) {
    return normalizePlaywrightModule(await import(pathToFileURL(env.MINIQUAD_PLAYWRIGHT_ENTRY).href));
  }
  const local = resolve(REPO_ROOT, "node_modules/playwright/index.js");
  if (existsSync(local)) return normalizePlaywrightModule(await import(pathToFileURL(local).href));
  const parent = dirname(REPO_ROOT);
  const siblings = readdirSync(parent).sort((a, b) => (a === "miniquad" ? -1 : b === "miniquad" ? 1 : 0));
  for (const name of siblings) {
    const candidate = resolve(parent, name, "node_modules/playwright/index.js");
    if (candidate !== local && existsSync(candidate)) return normalizePlaywrightModule(await import(pathToFileURL(candidate).href));
  }
  throw new Error("Playwright not found locally or in a sibling worktree. Set MINIQUAD_PLAYWRIGHT_ENTRY.");
}

const VIEWPORT = { width: 800, height: 500 };
const CHROMIUM_ARGS = ["--enable-webgl", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
const PHASE_CHECK_FILES = ["index.html", "gl.js", "miniquad.mjs", "runtime.html", "runtime.mjs", "host-preferences.mjs", "app.wasm"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Decodes a canvas screenshot PNG and reads the corner (10, 10) and
 * center pixels. See `phaseCheck`'s comment for why decoding the
 * screenshot, rather than an in-page canvas readback, is required. */
function decodeCanvasPixels(PNG, buffer, cornerX, cornerY) {
  const png = PNG.sync.read(buffer);
  const at = (x, y) => {
    const idx = (png.width * y + x) << 2;
    return [png.data[idx], png.data[idx + 1], png.data[idx + 2]];
  };
  return { corner: at(cornerX, cornerY), center: at(Math.floor(png.width / 2), Math.floor(png.height / 2)) };
}

async function launchEngine(playwright, engineName, { headful }) {
  const launchOptions = { headless: !headful };
  if (engineName === "chromium") launchOptions.args = CHROMIUM_ARGS;
  return playwright[engineName].launch(launchOptions);
}

async function newExercisePage(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    contrast: "no-preference",
    forcedColors: "none",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push({ type: "pageerror", message: String(error) }));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push({ type: "console-error", message: msg.text() });
  });
  page.on("requestfailed", (request) => errors.push({ type: "requestfailed", message: `${request.url()}: ${request.failure()?.errorText}` }));
  return { context, page, errors };
}

async function expectedHashesForManifest(manifest) {
  return new Map(manifest.files.map((entry) => [entry.file, entry.sha256]));
}

/** Runs the section 6.2 phase check against a page already navigated to
 * `/app/`. `expectManifest` is the active package's canonical manifest.
 * `expectStatus200` is false only for rollback-reload (a 304 is expected
 * there because the ETag changed back to the baseline value). `PNG` is
 * the lazily loaded `pngjs` decoder (see `loadPngjs`): the canvas has no
 * `preserveDrawingBuffer`, so its backbuffer is undefined once control
 * returns to page JavaScript, and an in-page `drawImage` readback of the
 * canvas element reads cleared (black) pixels. Only Playwright's own
 * `canvas.screenshot()` (compositor-level capture, taken before that
 * clear) observes the actually rendered frame; decoding its PNG bytes is
 * the one way to read real pixel values here. */
async function phaseCheck({ serverUrl, page, errors, expectManifest, expectRollbackReload, PNG }) {
  const expectedHashes = await expectedHashesForManifest(expectManifest);
  const fetchChecks = [];
  for (const file of [...PHASE_CHECK_FILES, "MANIFEST.json"]) {
    const response = await fetch(`${serverUrl}/app/${file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    const expected = file === "MANIFEST.json" ? null : expectedHashes.get(file);
    fetchChecks.push({ file, ok: file === "MANIFEST.json" || actual === expected, actual, expected });
  }

  const responseHashes = {};
  const responseListener = async (response) => {
    const url = new URL(response.url());
    const match = /\/app\/(.*)$/u.exec(url.pathname);
    if (!match) return;
    const fileName = match[1] || "index.html";
    if (!PHASE_CHECK_FILES.includes(fileName)) return;
    if (expectRollbackReload && response.status() === 304) {
      responseHashes[fileName] = { invalidReason: "304 is not valid in rollback-reload" };
      return;
    }
    try {
      const body = await response.body();
      responseHashes[fileName] = { status: response.status(), sha256: sha256(body) };
    } catch {
      // A 304 response has no body; that is expected for a warm reload
      // outside rollback-reload.
      responseHashes[fileName] = { status: response.status(), sha256: null };
    }
  };
  page.on("response", responseListener);

  await page.goto(`${serverUrl}/app/`, { waitUntil: "load" });
  await page.waitForSelector('#status[data-state="running"]', { timeout: 30000 });

  const runtimeFrame = page.frames().find((frame) => frame.url().includes("runtime.html"));
  if (!runtimeFrame) throw new Error("runtime frame not found");
  await runtimeFrame.waitForFunction(
    () => typeof miniquadRuntime !== "undefined" && miniquadRuntime.exports && miniquadRuntime.frames >= 3,
    null,
    { timeout: 30000, polling: 50 },
  );
  const abi = await runtimeFrame.evaluate(() => ({
    crateVersion: miniquadRuntime.exports.crate_version(),
    paramsVersion: miniquadRuntime.exports.mq_params_version(),
    frames: miniquadRuntime.frames,
  }));

  const canvas = page.frameLocator("iframe").first().locator("canvas").first();
  const screenshotBuffer = await canvas.screenshot();
  const beforePixel = decodeCanvasPixels(PNG, screenshotBuffer, 10, 10);

  await page.evaluate(() => {
    const input = document.querySelector("#background");
    input.value = "#112233";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const afterScreenshotBuffer = await canvas.screenshot();
  const afterPixel = decodeCanvasPixels(PNG, afterScreenshotBuffer, 10, 10).corner;

  page.off("response", responseListener);

  const pixelChecksPass =
    beforePixel.corner[0] === 16 && beforePixel.corner[1] === 16 && beforePixel.corner[2] === 26 &&
    (beforePixel.center[0] !== beforePixel.corner[0] || beforePixel.center[1] !== beforePixel.corner[1] || beforePixel.center[2] !== beforePixel.corner[2]) &&
    afterPixel[0] === 17 && afterPixel[1] === 34 && afterPixel[2] === 51;

  const pass =
    fetchChecks.every((c) => c.ok) &&
    abi.crateVersion === 3 &&
    abi.paramsVersion === 1 &&
    abi.frames >= 3 &&
    pixelChecksPass &&
    errors.length === 0;

  return {
    pass,
    fetchChecks,
    responseHashes,
    abi,
    beforePixel,
    afterPixel,
    pixelChecksPass,
    errors,
    screenshotSha256: sha256(screenshotBuffer),
    screenshotBuffer,
  };
}

/** Runs the four-phase rollout/rollback exercise (section 6.2) for one
 * engine, against a server already deployed with `createReleaseServer`. */
export async function runDrillEngine({ playwright, PNG, engineName, serverUrl, baselineManifest, candidateManifest, deploy, headful, outDir }) {
  const browser = await launchEngine(playwright, engineName, { headful });
  const version = browser.version();
  const phases = {};
  mkdirSync(outDir, { recursive: true });

  try {
    deploy("baseline");
    let exercise = await newExercisePage(browser);
    phases.baseline = await phaseCheck({ serverUrl, page: exercise.page, errors: exercise.errors, expectManifest: baselineManifest, PNG });
    writeFileSync(join(outDir, `${engineName}-baseline.png`), phases.baseline.screenshotBuffer);
    await exercise.context.close();

    deploy("candidate");
    const candidateExercise = await newExercisePage(browser);
    phases.candidate = await phaseCheck({ serverUrl, page: candidateExercise.page, errors: candidateExercise.errors, expectManifest: candidateManifest, PNG });
    writeFileSync(join(outDir, `${engineName}-candidate.png`), phases.candidate.screenshotBuffer);

    deploy("baseline");
    exercise = await newExercisePage(browser);
    phases["rollback-fresh"] = await phaseCheck({ serverUrl, page: exercise.page, errors: exercise.errors, expectManifest: baselineManifest, PNG });
    writeFileSync(join(outDir, `${engineName}-rollback-fresh.png`), phases["rollback-fresh"].screenshotBuffer);
    await exercise.context.close();

    const rollbackReloadErrors = [];
    candidateExercise.page.on("pageerror", (error) => rollbackReloadErrors.push({ type: "pageerror", message: String(error) }));
    await candidateExercise.page.reload({ waitUntil: "load" });
    phases["rollback-reload"] = await phaseCheck({
      serverUrl,
      page: candidateExercise.page,
      errors: [...candidateExercise.errors, ...rollbackReloadErrors],
      expectManifest: baselineManifest,
      expectRollbackReload: true,
      PNG,
    });
    writeFileSync(join(outDir, `${engineName}-rollback-reload.png`), phases["rollback-reload"].screenshotBuffer);
    await candidateExercise.context.close();
  } finally {
    await browser.close();
  }

  const result = Object.values(phases).every((phase) => phase.pass) ? "PASS" : "FAIL";
  return {
    engine: engineName,
    browserVersion: version,
    result,
    phases: Object.fromEntries(
      Object.entries(phases).map(([name, phase]) => [
        name,
        { pass: phase.pass, fetchChecks: phase.fetchChecks, abi: phase.abi, errors: phase.errors, screenshotSha256: phase.screenshotSha256 },
      ]),
    ),
  };
}

export async function drill(options) {
  const playwright = await loadPlaywright();
  const PNG = await loadPngjs();
  const baselineDir = resolve(options.baseline);
  const candidateDir = resolve(options.candidate);
  const outDir = resolve(options.out);
  if (existsSync(outDir)) throw new Error(`--out must not already exist: ${outDir}`);
  mkdirSync(outDir, { recursive: true });

  const baselineManifest = JSON.parse(readFileSync(join(baselineDir, "payload", "MANIFEST.json"), "utf8"));
  const candidateManifest = JSON.parse(readFileSync(join(candidateDir, "payload", "MANIFEST.json"), "utf8"));
  const server = await createReleaseServer({
    packages: { baseline: { dir: baselineDir }, candidate: { dir: candidateDir } },
  });

  const engines = (options.engines || "chromium,firefox,webkit").split(",").map((s) => s.trim());
  const headfulEngines = new Set((options.headful && options.headful !== "none" ? options.headful.split(",") : []).map((s) => s.trim()));

  const results = [];
  try {
    for (const engineName of engines) {
      const result = await runDrillEngine({
        playwright,
        PNG,
        engineName,
        serverUrl: server.url,
        baselineManifest,
        candidateManifest,
        deploy: server.deploy,
        headful: headfulEngines.has(engineName),
        outDir,
      });
      results.push(result);
    }
  } finally {
    await server.close();
  }

  const record = {
    schema: "miniquad-release-drill/1",
    engines: results,
    result: results.every((r) => r.result === "PASS") ? "PASS" : "FAIL",
  };
  writeFileSync(join(outDir, "drill.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ result: record.result, engines: results.map((r) => ({ engine: r.engine, result: r.result })) }, null, 2));
  return record;
}

// ---------------------------------------------------------------------
// `measure`
// ---------------------------------------------------------------------

function clockSampleScript() {
  const deadline = performance.now() + 50;
  const readings = [performance.now()];
  while (performance.now() < deadline && readings.length < 2000) {
    const value = performance.now();
    if (value !== readings[readings.length - 1]) readings.push(value);
  }
  return readings;
}

async function measureOneRun({ page, errors, warm }) {
  const start = performance.now;
  const coldStartupToRunningMs = await page.evaluate(() => new Promise((resolvePromise) => {
    const start = performance.now();
    const statusEl = document.getElementById("status");
    if (statusEl?.dataset.state === "running") {
      resolvePromise(performance.now() - start);
      return;
    }
    const observer = new MutationObserver(() => {
      if (statusEl?.dataset.state === "running") {
        observer.disconnect();
        resolvePromise(performance.now() - start);
      }
    });
    observer.observe(statusEl, { attributes: true, attributeFilter: ["data-state"] });
  }));

  const coldStartupToFirstFrameMs = await page.evaluate(() => new Promise((resolvePromise) => {
    const start = performance.now();
    function poll() {
      const frame = [...document.querySelectorAll("iframe")].map((f) => f.contentWindow?.miniquadRuntime).find(Boolean);
      if (frame && frame.frames >= 1) {
        resolvePromise(performance.now() - start);
        return;
      }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  }));

  let frameIntervalSamples = null;
  if (warm) {
    const runtimeFrame = page.frames().find((frame) => frame.url().includes("runtime.html"));
    await runtimeFrame.waitForFunction(() => miniquadRuntime.frames >= 3, null, { timeout: 30000, polling: 50 });
    frameIntervalSamples = await runtimeFrame.evaluate(() => new Promise((resolvePromise) => {
      const times = [];
      function record(t) {
        times.push(t);
        if (times.length < 121) requestAnimationFrame(record);
        else resolvePromise(times);
      }
      requestAnimationFrame(record);
    }));
  }

  const clockSamplesTop = await page.evaluate(clockSampleScript);
  let clockSamplesRuntime = null;
  const runtimeFrame = page.frames().find((frame) => frame.url().includes("runtime.html"));
  if (runtimeFrame) clockSamplesRuntime = await runtimeFrame.evaluate(clockSampleScript);

  const wasmMemoryBytes = await (runtimeFrame?.evaluate(() => miniquadRuntime.exports.memory.buffer.byteLength).catch(() => null)) ?? null;
  const webglRenderer = await page.evaluate(() => {
    const canvasEl = document.querySelector("#host canvas, canvas");
    const gl = canvasEl?.getContext("webgl") || canvasEl?.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  }).catch(() => null);

  void start;
  return {
    coldStartupToRunningMs,
    coldStartupToFirstFrameMs,
    frameIntervalSamples,
    clockSamplesTop,
    clockSamplesRuntime,
    wasmMemoryBytes,
    webglRenderer,
    errorCount: errors.length,
  };
}

function framesToIntervals(times) {
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1]);
  return intervals;
}

export function evaluateRegression(samples) {
  const regression = { schema: "miniquad-release-regression/1", profileId: samples.profile, engines: {}, result: "PASS" };
  const metricExtractors = {
    coldStartupToRunningMs: (r) => r.cold?.coldStartupToRunningMs,
    coldStartupToFirstFrameMs: (r) => r.cold?.coldStartupToFirstFrameMs,
    warmStartupToRunningMs: (r) => r.warm?.coldStartupToRunningMs,
    warmFrameIntervalP95Ms: (r) => {
      const times = r.warm?.frameIntervalSamples;
      if (!Array.isArray(times) || times.length < 2 ||
          !times.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
      const intervals = framesToIntervals(times);
      if (intervals.some((value) => value < 0)) return undefined;
      return nearestRank(intervals.sort((a, b) => a - b), 0.95);
    },
  };
  for (const engineName of ["chromium", "firefox", "webkit"]) {
    const engineData = samples.engines?.[engineName];
    const runs = Array.isArray(engineData?.runs) ? engineData.runs : [];
    const valid = runs.filter((run) => run && !run.invalidReason &&
      ["baseline", "candidate"].includes(run.variant) &&
      Object.values(metricExtractors).every((extract) => {
        const value = extract(run);
        return Number.isFinite(value) && value >= 0;
      }));
    const invalidSampleCount = runs.length - valid.length;
    const baselineRuns = valid.filter((r) => r.variant === "baseline");
    const candidateRuns = valid.filter((r) => r.variant === "candidate");
    const runResolutions = valid.map((r) => clockResolution([
      r.cold?.clockSamplesTop, r.cold?.clockSamplesRuntime,
      r.warm?.clockSamplesTop, r.warm?.clockSamplesRuntime,
    ].filter(Array.isArray)));
    const resolution = engineData?.versionMismatch || invalidSampleCount > 0 ||
      runResolutions.length === 0 || runResolutions.some((value) => !Number.isFinite(value) || value <= 0)
      ? null
      : runResolutions.reduce((largest, value) => Math.max(largest, value), 0);
    const metrics = {};
    let engineResult = "PASS";
    for (const [metricName, extract] of Object.entries(metricExtractors)) {
      const evaluation = engineData?.versionMismatch
        ? { result: "INCONCLUSIVE", reason: "browser version differs between baseline and candidate runs" }
        : invalidSampleCount > 0
          ? { result: "INCONCLUSIVE", reason: "a retained sample is invalid" }
          : evaluateMetric({ baseline: baselineRuns.map(extract), candidate: candidateRuns.map(extract), resolution });
      metrics[metricName] = evaluation;
      if (evaluation.result === "FAIL") engineResult = "FAIL";
      else if (evaluation.result === "INCONCLUSIVE" && engineResult !== "FAIL") engineResult = "INCONCLUSIVE";
    }
    regression.engines[engineName] = { result: engineResult, resolution, metrics, validSampleCount: valid.length, invalidSampleCount };
    if (engineResult === "FAIL") regression.result = "FAIL";
    else if (engineResult === "INCONCLUSIVE" && regression.result !== "FAIL") regression.result = "INCONCLUSIVE";
  }
  return regression;
}

export async function measure(options) {
  const pairs = Number(options.pairs ?? 20);
  if (!Number.isSafeInteger(pairs) || pairs < 20) throw new Error("--pairs must be an integer of 20 or more");
  const playwright = await loadPlaywright();
  const baselineDir = resolve(options.baseline);
  const candidateDir = resolve(options.candidate);
  const outDir = resolve(options.out);
  if (existsSync(outDir)) throw new Error(`--out must not already exist: ${outDir}`);
  mkdirSync(outDir, { recursive: true });

  const server = await createReleaseServer({
    packages: { baseline: { dir: baselineDir }, candidate: { dir: candidateDir } },
  });

  const engines = (options.engines || "chromium,firefox,webkit").split(",").map((s) => s.trim());
  const headfulEngines = new Set((options.headful && options.headful !== "none" ? options.headful.split(",") : []).map((s) => s.trim()));
  const samples = { profile: options.profile || null, engines: {} };

  try {
    for (const engineName of engines) {
      const browser = await launchEngine(playwright, engineName, { headful: headfulEngines.has(engineName) });
      const browserVersion = browser.version();
      const runs = [];
      let versionMismatch = false;
      try {
        for (let i = 0; i < pairs; i += 1) {
          const order = i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
          for (const variant of order) {
            const loadBefore = os.loadavg();
            server.deploy(variant);
            const { context, page, errors } = await newExercisePage(browser);
            let cold = null;
            let warm = null;
            let invalidReason = null;
            try {
              await page.goto(`${server.url}/app/`, { waitUntil: "load", timeout: 30000 });
              cold = await measureOneRun({ page, errors, warm: false });
              let warmResponseWas200 = false;
              page.on("response", (response) => {
                const url = new URL(response.url());
                if (/\/app\//u.test(url.pathname) && response.request().url() !== page.url() && response.status() === 200) {
                  warmResponseWas200 = true;
                }
              });
              await page.reload({ waitUntil: "load", timeout: 30000 });
              warm = await measureOneRun({ page, errors, warm: true });
              if (warmResponseWas200) invalidReason = "a warm payload response was 200, not 304";
              if (errors.length > 0) invalidReason = invalidReason || "an error occurred during the run";
            } catch (error) {
              invalidReason = error.message;
            }
            const loadAfter = os.loadavg();
            runs.push({ pairIndex: i, variant, loadBefore, loadAfter, cold, warm, invalidReason, browserVersion: await page.evaluate(() => navigator.userAgent).catch(() => null) });
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
      const firstVersion = runs.find((r) => r.browserVersion)?.browserVersion;
      versionMismatch = runs.some((r) => r.browserVersion && r.browserVersion !== firstVersion);
      samples.engines[engineName] = { browserVersion, versionMismatch, runs };
    }
  } finally {
    await server.close();
  }

  writeFileSync(join(outDir, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`);

  const regression = evaluateRegression(samples);

  writeFileSync(join(outDir, "regression.json"), `${JSON.stringify(regression, null, 2)}\n`);
  console.log(JSON.stringify({ result: regression.result, engines: Object.fromEntries(Object.entries(regression.engines).map(([k, v]) => [k, v.result])) }, null, 2));
  return regression;
}

// ---------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return options;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const options = parseArgs(rest);
  if (command === "drill") {
    const record = await drill(options);
    if (record.result !== "PASS") process.exitCode = 1;
  } else if (command === "measure") {
    const record = await measure(options);
    if (record.result !== "PASS") process.exitCode = 1;
  } else {
    console.error("Usage: node scripts/release-browser.mjs <drill|measure> [options]");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
