import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const baseUrl = "http://127.0.0.1:4174";
const fixture = JSON.parse(await readFile(join(here, "fixture.json"), "utf8"));
const sourceSha = process.env.MINIQUAD_SOURCE_SHA || execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: root, encoding: "utf8" }
).trim();
const pixelCount = fixture.width * fixture.height;
const tolerancePercentLimit = Math.floor(pixelCount * 0.001);
let server;
let browser;

function assertHardwareAdapter(info) {
  const renderer = info.renderer || "";
  assert.ok(renderer, "WEBGL_debug_renderer_info did not report a renderer");
  assert.doesNotMatch(
    renderer,
    /swiftshader|llvmpipe|software rasterizer|software renderer/i,
    `software adapter cannot satisfy the hardware parity gate: ${renderer}`
  );
}

function difference(first, second, tolerance = 0) {
  assert.equal(first.length, second.length);
  let differentPixels = 0;
  let maxChannelDifference = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(first[offset + channel] - second[offset + channel]);
      maxChannelDifference = Math.max(maxChannelDifference, delta);
      if (delta > tolerance) pixelDiffers = true;
    }
    if (pixelDiffers) differentPixels += 1;
  }
  return { differentPixels, maxChannelDifference };
}

function verifyNativeCapture(pixels) {
  assert.equal(pixels.length, pixelCount * 4, "native capture length does not match the fixture");
  for (const check of [...fixture.visualChecks, ...fixture.absentChecks]) {
    const [x, y] = check.sample;
    const offset = (y * fixture.width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      assert.ok(
        Math.abs(pixels[offset + channel] - check.color[channel]) <= 2,
        `native ${check.layer} sample ${check.sample} channel ${channel}: ` +
          `expected ${check.color[channel]}, got ${pixels[offset + channel]}`
      );
    }
  }
  let nonBackgroundPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    assert.equal(pixels[offset + 3], 255, "native capture alpha must be opaque");
    if (
      pixels[offset] !== fixture.background[0] ||
      pixels[offset + 1] !== fixture.background[1] ||
      pixels[offset + 2] !== fixture.background[2]
    ) {
      nonBackgroundPixels += 1;
    }
  }
  assert.ok(nonBackgroundPixels > 0, "native capture is empty");
  return { nonBackgroundPixels, samples: [...fixture.visualChecks, ...fixture.absentChecks].map((check) => check.layer) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function rng(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function shuffledPairOrder(seed) {
  const random = rng(seed);
  const orders = [
    ...Array.from({ length: 10 }, () => ["miniquad", "plain"]),
    ...Array.from({ length: 10 }, () => ["plain", "miniquad"]),
  ];
  for (let index = orders.length - 1; index > 0; index -= 1) {
    const other = random() % (index + 1);
    [orders[index], orders[other]] = [orders[other], orders[index]];
  }
  return orders;
}

function bootstrapMedianInterval(deltas, seed) {
  const random = rng(seed);
  const samples = [];
  for (let sample = 0; sample < 10000; sample += 1) {
    const resample = Array.from(
      { length: deltas.length },
      () => deltas[random() % deltas.length]
    );
    samples.push(median(resample));
  }
  return {
    lower: quantile(samples, 0.025),
    upper: quantile(samples, 0.975),
    resamples: samples.length,
    seed: seed.toString(16).padStart(8, "0"),
  };
}

async function measureRun(page, arm, runId) {
  const started = performance.now();
  await page.goto(`${baseUrl}/?arm=${arm}&run=${runId}`);
  await page.waitForFunction(
    () => window.__comparisonReady === true || typeof window.__comparisonError === "string",
    null,
    { timeout: 30000 }
  );
  const error = await page.evaluate(() => window.__comparisonError || null);
  assert.equal(error, null, `${arm} measurement startup failed: ${error}`);
  await page.evaluate(() => window.__comparisonWaitFrames(1));
  const coldStartupMs = performance.now() - started;
  const run = await page.evaluate(async () => {
    window.__comparisonResetTiming();
    await window.__comparisonWaitFrames(60);
    window.__comparisonResetTiming();
    await window.__comparisonWaitFrames(300);
    const timing = window.__comparisonTiming;
    if (timing.samples.length !== 300) {
      throw new Error(`expected 300 measured callbacks, got ${timing.samples.length}`);
    }
    return {
      callbackMs: timing.samples,
      intervalsMs: timing.intervals.filter((interval) => interval !== null),
    };
  });
  return {
    arm,
    coldStartupMs,
    medianCallbackMs: median(run.callbackMs),
    callbackMs: run.callbackMs,
    intervalsMs: run.intervalsMs,
  };
}

async function assetSizes(arm) {
  const common = ["experiments/webgl2-comparison/index.html", "js/gl.js"];
  const armAssets = arm === "miniquad"
    ? ["target/wasm32-unknown-unknown/release/webgl2-comparison.wasm"]
    : ["experiments/webgl2-comparison/plain.mjs", "experiments/webgl2-comparison/fixture.json"];
  const files = await Promise.all([...common, ...armAssets].map(async (path) => {
    const data = await readFile(join(root, path));
    return {
      path,
      raw: data.byteLength,
      gzip: gzipSync(data).byteLength,
      brotli: brotliCompressSync(data).byteLength,
    };
  }));
  return {
    raw: files.reduce((total, file) => total + file.raw, 0),
    gzip: files.reduce((total, file) => total + file.gzip, 0),
    brotli: files.reduce((total, file) => total + file.brotli, 0),
    files: files.map(({ path, raw, gzip, brotli }) => ({ path, raw, gzip, brotli })),
  };
}

async function sourceLines(path) {
  const text = await readFile(join(root, path), "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function fnv64(data) {
  let hash = 0xcbf29ce484222325n;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  const update = (byte) => {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  };
  for (const value of data.vertices) {
    view.setFloat32(0, Math.fround(value), true);
    for (const byte of new Uint8Array(buffer)) update(byte);
  }
  for (const value of data.indices) {
    update(value & 0xff);
    update((value >>> 8) & 0xff);
  }
  return hash.toString(16).padStart(16, "0");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && await response.text() === "ok") return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error("comparison server did not become ready");
}

async function openArm(context, arm) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/?arm=${arm}`);
  await page.waitForFunction(
    () => window.__comparisonReady === true || typeof window.__comparisonError === "string",
    null,
    { timeout: 30000 }
  );
  const loadError = await page.evaluate(() => window.__comparisonError || null);
  assert.equal(loadError, null, `${arm} startup failed: ${loadError}`);
  await page.evaluate(() => window.__comparisonWaitFrames(3));
  assert.deepEqual(errors, [], `${arm} raised a page error`);
  return page;
}

async function verifyArm(context, arm) {
  const page = await openArm(context, arm);
  const info = await page.evaluate(() => window.__comparisonContextInfo());
  assertHardwareAdapter(info);
  assert.match(info.version, /WebGL 2\.0/);
  assert.equal(info.drawingBufferColorSpace, "srgb");
  assert.equal(info.attributes.antialias, false);
  assert.equal(info.attributes.premultipliedAlpha, false);
  assert.equal(info.attributes.preserveDrawingBuffer, true);
  assert.equal(info.attributes.alpha, true);

  const metadata = await page.evaluate(() => {
    if (window.__comparisonArm === "plain-webgl2") {
      return {
        ...window.__comparisonFixture.counts,
        meshFnv64: window.__comparisonFixture.meshFnv64,
      };
    }
    const exports = window.wasm_exports;
    return {
      occupiedCells: exports.comparison_occupied_cells(),
      voxelLevels: exports.comparison_voxel_levels(),
      pathPoints: exports.comparison_path_points(),
      arrows: exports.comparison_arrows(),
      vectorItems: exports.comparison_vector_items(),
      meshFnv64: exports.comparison_mesh_hash64().toString(16).padStart(16, "0"),
    };
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "meshFnv64")),
    fixture.counts
  );
  assert.equal(fnv64(fixture), fixture.meshFnv64);
  assert.equal(metadata.meshFnv64, fixture.meshFnv64);

  const maxSameArmDifference = await page.evaluate(async () => {
    const capture = async () => Uint8Array.from(await window.__comparisonReadPixels());
    const compare = (a, b) => {
      let max = 0;
      for (let offset = 0; offset < a.length; offset += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          max = Math.max(max, Math.abs(a[offset + channel] - b[offset + channel]));
        }
      }
      return max;
    };
    let max = 0;
    for (let pair = 0; pair < 10; pair += 1) {
      const first = await capture();
      await window.__comparisonWaitFrames(2);
      const second = await capture();
      max = Math.max(max, compare(first, second));
    }
    return max;
  });

  const layerMasks = { grid: 1, voxels: 2, path: 4, arrow: 4, background: 7 };
  const samples = [];
  for (const check of fixture.visualChecks) {
    await page.evaluate(async (mask) => {
      window.__comparisonSetLayerMask(mask);
      await window.__comparisonWaitFrames(2);
    }, layerMasks[check.layer]);
    const actual = await page.evaluate(
      ([x, y]) => window.__comparisonReadSample(x, y),
      check.sample
    );
    for (let channel = 0; channel < 4; channel += 1) {
      assert.ok(
        Math.abs(actual[channel] - check.color[channel]) <= 2,
        `${arm} ${check.layer} sample ${check.sample} channel ${channel}: ` +
          `expected ${check.color[channel]}, got ${actual[channel]}`
      );
    }
    samples.push({ layer: check.layer, actual });
  }

  const absentSamples = [];
  for (const check of fixture.absentChecks) {
    const actual = await page.evaluate(
      ([x, y]) => window.__comparisonReadSample(x, y),
      check.sample
    );
    for (let channel = 0; channel < 4; channel += 1) {
      assert.ok(
        Math.abs(actual[channel] - check.color[channel]) <= 2,
        `${arm} ${check.layer} absent sample ${check.sample} channel ${channel}: ` +
          `expected ${check.color[channel]}, got ${actual[channel]}`
      );
    }
    absentSamples.push({ layer: check.layer, actual });
  }

  await page.evaluate(async () => {
    window.__comparisonSetLayerMask(7);
    await window.__comparisonWaitFrames(2);
  });
  const pixels = Buffer.from(
    await page.evaluate(() => window.__comparisonReadPixelsBase64()),
    "base64"
  );
  assert.equal(pixels.length, pixelCount * 4);
  for (let offset = 3; offset < pixels.length; offset += 4) {
    assert.equal(pixels[offset], 255, `${arm} output alpha must be opaque`);
  }

  const controlDiff = await page.evaluate(() => window.__comparisonKnownBad());
  assert.ok(controlDiff.differentPixels >= 1024, `${arm} known-bad control changed too few pixels`);
  assert.ok(controlDiff.differentPixels > tolerancePercentLimit, `${arm} control did not exceed the A/B limit`);

  return {
    page,
    info,
    metadata,
    maxSameArmDifference,
    pixels,
    samples,
    absentSamples,
    controlDiff,
  };
}

try {
  assert.equal(fnv64(fixture), fixture.meshFnv64, "fixture mesh hash does not match its stored digest");
  server = spawn(process.execPath, [join(here, "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  await waitForServer();
  browser = await chromium.launch({
    headless: process.env.MINIQUAD_HEADFUL !== "1",
    ...(process.env.MINIQUAD_CHROMIUM_CHANNEL ? { channel: process.env.MINIQUAD_CHROMIUM_CHANNEL } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    deviceScaleFactor: 1,
  });

  const miniquad = await verifyArm(context, "miniquad");
  const plain = await verifyArm(context, "plain");
  assert.equal(miniquad.info.renderer, plain.info.renderer, "browser arms used different adapters");
  assert.equal(miniquad.info.version, plain.info.version, "browser arms used different WebGL versions");
  assert.deepEqual(miniquad.info.attributes, plain.info.attributes, "browser context attributes differ");
  assert.equal(
    miniquad.info.drawingBufferColorSpace,
    plain.info.drawingBufferColorSpace,
    "browser arms used different drawing-buffer color spaces"
  );
  const tolerance = Math.max(miniquad.maxSameArmDifference, plain.maxSameArmDifference) + 2;
  const parity = difference(miniquad.pixels, plain.pixels, tolerance);
  assert.ok(
    parity.differentPixels <= tolerancePercentLimit,
    `browser pixel parity failed: ${parity.differentPixels} pixels differ (limit ${tolerancePercentLimit}, tolerance ${tolerance})`
  );
  const nativeCapturePath = process.env.MINIQUAD_NATIVE_CAPTURE_PATH;
  assert.ok(nativeCapturePath, "set MINIQUAD_NATIVE_CAPTURE_PATH to a Metal capture");
  const nativeCapture = await readFile(nativeCapturePath);
  const nativeValidation = verifyNativeCapture(nativeCapture);
  const crossApiPixels = difference(nativeCapture, miniquad.pixels);

  await miniquad.page.close();
  await plain.page.close();
  const timingPage = await context.newPage();
  const timingErrors = [];
  timingPage.on("pageerror", (error) => timingErrors.push(error.message));
  let runId = 0;
  const sameArmPairs = { miniquad: [], plain: [] };
  const runsByArm = { miniquad: [], plain: [] };
  for (const arm of ["miniquad", "plain"]) {
    for (let pair = 0; pair < 10; pair += 1) {
      const first = await measureRun(timingPage, arm, `aa-${arm}-${pair}-a-${runId++}`);
      const second = await measureRun(timingPage, arm, `aa-${arm}-${pair}-b-${runId++}`);
      sameArmPairs[arm].push({
        firstMs: first.medianCallbackMs,
        secondMs: second.medianCallbackMs,
        deltaMs: second.medianCallbackMs - first.medianCallbackMs,
      });
      runsByArm[arm].push(first, second);
    }
  }

  const pairSeed = Number.parseInt(sourceSha.slice(0, 8), 16) >>> 0;
  const pairOrder = shuffledPairOrder(pairSeed);
  const abPairs = [];
  for (let pair = 0; pair < pairOrder.length; pair += 1) {
    const [firstArm, secondArm] = pairOrder[pair];
    const first = await measureRun(timingPage, firstArm, `ab-${pair}-${firstArm}-${runId++}`);
    const second = await measureRun(timingPage, secondArm, `ab-${pair}-${secondArm}-${runId++}`);
    const results = {
      [firstArm]: first,
      [secondArm]: second,
    };
    const deltaMs = results.miniquad.medianCallbackMs - results.plain.medianCallbackMs;
    abPairs.push({
      order: [firstArm, secondArm],
      miniquadMs: results.miniquad.medianCallbackMs,
      plainMs: results.plain.medianCallbackMs,
      deltaMs,
    });
    runsByArm[firstArm].push(first);
    runsByArm[secondArm].push(second);
    if ((pair + 1) % 5 === 0) console.error(`Completed ${pair + 1}/20 A/B pairs`);
  }
  assert.deepEqual(timingErrors, [], "a timing run raised a browser page error");
  await timingPage.close();

  const deltas = abPairs.map((pair) => pair.deltaMs);
  const bootstrapSeed = createHash("sha256")
    .update(sourceSha)
    .update(":bootstrap")
    .digest()
    .readUInt32LE(0);
  const timingSummary = Object.fromEntries(
    ["miniquad", "plain"].map((arm) => {
      const runs = runsByArm[arm];
      const intervals = runs.flatMap((run) => run.intervalsMs);
      const startups = runs.map((run) => run.coldStartupMs);
      return [arm, {
        runCount: runs.length,
        medianCallbackMs: median(runs.map((run) => run.medianCallbackMs)),
        callbackP50Ms: quantile(runs.map((run) => run.medianCallbackMs), 0.5),
        frameIntervalMs: {
          p50: quantile(intervals, 0.5),
          p95: quantile(intervals, 0.95),
          p99: quantile(intervals, 0.99),
        },
        coldStartupMs: {
          median: median(startups),
          p95: quantile(startups, 0.95),
        },
      }];
    })
  );
  const assetTransfer = {
    miniquad: await assetSizes("miniquad"),
    plain: await assetSizes("plain"),
    compression: {
      method: "gzipSync and brotliCompressSync per served file",
      node: process.version,
      zlib: process.versions.zlib,
    },
  };
  const sourceLoc = {
    rule: "count non-empty source lines; do not count generated fixture data",
    miniquad: await sourceLines("experiments/webgl2-comparison/rust/src/main.rs"),
    plain: await sourceLines("experiments/webgl2-comparison/plain.mjs"),
  };

  console.log(JSON.stringify({
    sourceSha,
    browser: await browser.version(),
    webglVersion: miniquad.info.version,
    shadingLanguageVersion: miniquad.info.shadingLanguageVersion,
    adapter: miniquad.info,
    fixtureSha256: (await readFile(join(here, "fixture.sha256"), "utf8")).trim(),
    meshFnv64: fixture.meshFnv64,
    maxSameArmDifference: {
      miniquad: miniquad.maxSameArmDifference,
      plain: plain.maxSameArmDifference,
    },
    pixelTolerance: tolerance,
    parity,
    nativeCapture: {
      path: nativeCapturePath,
      graphicsApi: "Metal",
      pixelFormat: "RGBA8, normalized from BGRA storage; top-left rows",
      width: fixture.width,
      height: fixture.height,
      validation: nativeValidation,
    },
    crossApiDifference: {
      descriptiveOnly: true,
      ...crossApiPixels,
      differentPixelPercent: (crossApiPixels.differentPixels / pixelCount) * 100,
    },
    controls: {
      miniquad: miniquad.controlDiff,
      plain: plain.controlDiff,
    },
    samples: {
      miniquad: miniquad.samples,
      plain: plain.samples,
    },
    absentSamples: {
      miniquad: miniquad.absentSamples,
      plain: plain.absentSamples,
    },
    timing: {
      warmupFramesPerRun: 60,
      measuredFramesPerRun: 300,
      sameArmPairs,
      pairOrderSeed: pairSeed.toString(16).padStart(8, "0"),
      pairOrder,
      abPairs,
      primaryMetric: "paired median callback CPU duration; delta = Miniquad - plain WebGL2",
      medianPairedDeltaMs: median(deltas),
      confidenceInterval95Ms: bootstrapMedianInterval(deltas, bootstrapSeed),
      perArm: timingSummary,
    },
    assets: assetTransfer,
    sourceLoc,
  }, null, 2));
  await context.close();
} finally {
  await browser?.close();
  server?.kill();
}
