import { test, expect } from "@playwright/test";

// Status codes mirrored from examples/gpu_timer_query/core.rs's
// `HarnessStatus` enum. Keep these two definitions in sync by hand; this
// file has no build step that could check them automatically.
const STATUS_PENDING = 0;
const STATUS_UNSUPPORTED = 1;
const STATUS_DISJOINT = 2;
const STATUS_READY = 3;
const STATUS_TIMEOUT = 4;

async function waitForTerminalStatus(page) {
  await page.waitForFunction(() => {
    if (typeof wasm_exports !== "object" || typeof wasm_exports.gpu_timer_query_status !== "function") {
      return false;
    }
    const status = wasm_exports.gpu_timer_query_status();
    return status !== 0; // STATUS_PENDING
  }, { timeout: 30000 });
  return page.evaluate(() => ({
    status: wasm_exports.gpu_timer_query_status(),
    resultLo: wasm_exports.gpu_timer_query_result_lo(),
    resultHi: wasm_exports.gpu_timer_query_result_hi()
  }));
}

async function readGpuEvidence(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("#glcanvas");
    const gl1 = canvas.getContext("webgl");
    const gl2 = canvas.getContext("webgl2");
    const evidence = {
      userAgent: navigator.userAgent,
      webgl1Available: !!gl1,
      webgl2Available: !!gl2,
      disjointTimerQueryWebgl2Extension: null,
      unmaskedVendor: null,
      unmaskedRenderer: null
    };
    const activeGl = gl2 || gl1;
    if (activeGl) {
      if (gl2) {
        evidence.disjointTimerQueryWebgl2Extension = !!gl2.getSupportedExtensions()
          .includes("EXT_disjoint_timer_query_webgl2");
      }
      const debugInfo = activeGl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        evidence.unmaskedVendor = activeGl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        evidence.unmaskedRenderer = activeGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
    }
    return evidence;
  });
}

test("WebGL1 context reports the GPU timer query as an explicit unsupported state, not a 0 placeholder", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/gpu-timer-query-webgl1", { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.gpu_timer_query_status === "function");

  const outcome = await waitForTerminalStatus(page);
  const evidence = await readGpuEvidence(page);
  await testInfo.attach("gpu-timer-query-webgl1-evidence.json", {
    body: JSON.stringify({ outcome, evidence, errors }, null, 2),
    contentType: "application/json"
  });

  expect(errors, "No uncaught page error").toEqual([]);
  // EXT_disjoint_timer_query_webgl2 does not exist on a WebGL1 context;
  // gl.getQuery is absent there too, so is_supported() must report
  // Unsupported without a panic (MADR 0023), never a success-shaped 0.
  expect(outcome.status).toBe(STATUS_UNSUPPORTED);
});

test("WebGL2 context on a hardware adapter gives a real nonzero GPU timer-query result", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/gpu-timer-query-webgl2", { waitUntil: "load" });
  await page.waitForFunction(() => typeof wasm_exports === "object" &&
    typeof wasm_exports.gpu_timer_query_status === "function");

  const evidence = await readGpuEvidence(page);
  const outcome = await waitForTerminalStatus(page);
  const resultValue = (BigInt(outcome.resultHi) << 32n) | BigInt(outcome.resultLo >>> 0);

  await testInfo.attach("gpu-timer-query-webgl2-evidence.json", {
    body: JSON.stringify({
      outcome: { ...outcome, resultValue: resultValue.toString() },
      evidence,
      errors,
      statusNames: { STATUS_PENDING, STATUS_UNSUPPORTED, STATUS_DISJOINT, STATUS_READY, STATUS_TIMEOUT }
    }, null, 2),
    contentType: "application/json"
  });

  expect(errors, "No uncaught page error").toEqual([]);

  const isSoftwareAdapter = /swiftshader|software|llvmpipe/iu.test(evidence.unmaskedRenderer || "");
  test.info().annotations.push({
    type: "gpu-adapter",
    description: `renderer=${evidence.unmaskedRenderer} vendor=${evidence.unmaskedVendor} software=${isSoftwareAdapter}`
  });

  if (isSoftwareAdapter) {
    // The task that authored this test requires a hardware-adapter nonzero
    // result; a software rasterizer (SwiftShader/llvmpipe) cannot give that
    // proof. Report this run as blocked rather than claim a GPU result.
    test.fail(true, "BLOCKED: this browser session used a software graphics adapter ("
      + evidence.unmaskedRenderer + "); a hardware-adapter nonzero GPU timer-query result "
      + "cannot be claimed from this run. See MADR 0023 and the task's explicit instruction "
      + "to report blocked rather than claim a result in this case.");
    return;
  }

  expect(evidence.disjointTimerQueryWebgl2Extension,
    "EXT_disjoint_timer_query_webgl2 must be reported as supported by the browser for a nonzero-result claim")
    .toBe(true);
  expect(outcome.status, "Query must resolve to Ready, not Unsupported/Disjoint/Timeout").toBe(STATUS_READY);
  expect(resultValue > 0n, "A real hardware GPU timer query must report a nonzero elapsed time").toBe(true);
});
