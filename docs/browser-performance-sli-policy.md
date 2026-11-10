# Browser-first performance SLI measurement policy

* Review date: 2026-11-10
* Tracking: [#12 performance/SLO](https://github.com/Tigon32/miniquad/issues/12)
* Baseline source: current PR head as reported in CI; results are **not** copied from an untested local machine
* State: **Measured SLI receipts; no calibrated release SLO is enforced**

## Terminology

* **SLI (service-level indicator):** A value collected from a specified
  build, browser and test scenario.
* **SLO (service-level objective):** A target selected after repeated runs
  and review of actual device, browser and network data.
* **Release gate:** A rule that blocks a candidate only after its data
  collection and allowed variability have been approved.

A provisional budget is a hypothesis, **not** a measured result or
an enforced gate. The first required PR run publishes baseline receipts.
Comparison PRs must cite their own revision and both measured receipts.

## Measurements and how to reproduce them

| SLI | Collection method | Reported units | Known limits |
| --- | --- | --- | --- |
| Raw and compressed JavaScript + WASM | `node scripts/measure-bundle-size.mjs` on actual `js/gl.js`, release quad and offscreen WASM | Bytes, SHA-256, gzip level 9, Brotli quality 11 | Computed compression, not captured HTTP transfer, cache or CDN behavior |
| Startup to first GL draw submission | `tests/browser/performance-baseline.spec.mjs`, from navigation start to first `drawElements` call | Milliseconds | Not first visible painted pixel; may include transient shader compilation |
| Frame interval | 60+ requestAnimationFrame timestamps from the compiled WASM test page | p50, p95 and p99 in milliseconds | Refresh rate, CI host scheduling, timers and browser throttling change values |
| JavaScript-to-WASM frame callback CPU time | Wrap the compiled WASM `frame()` call after startup, observe 40+ samples | p50, p95 and p99 in milliseconds | Includes Rust/GL command submission; excludes asynchronous GPU completion |
| Navigation network response | Browser PerformanceNavigationTiming entry | Milliseconds and transfer bytes when available | Local HTTP and cache behavior are not a production network benchmark |
| Input latency | Synthetic event-to-Rust callback tests exist | **Not measured as a latency SLI** | No physical touch/controller hardware latency receipts |
| Peak and steady WASM heap | Compile-time memory exports available | **Not yet collected** | JavaScript memory APIs do not measure GPU allocations |
| GPU memory and GPU/frame stalls | GL extension or device-level tools needed | **Not measured** | No portable GPU memory API across the three browsers |

Use the checked-in `examples/quad.rs` fixture with its matching ABI v3
`js/gl.js`. The standard integration lane builds release WASM on
Ubuntu 24.04 and collects Chromium metrics on a fresh Playwright context.
The separate three-engine lane observes the same script on desktop Chromium,
Firefox and WebKit. Desktop WebKit is **not** iOS Safari.

The browser test records one initial navigation in an isolated context,
then approximately one second of warm animation. It is a small, reproducible
smoke baseline, not a statistically calibrated multi-day sample. For actual
SLO calibration repeat each fixture at least 20 times in a controlled browser
and network environment and report dispersion, outliers, device model, OS,
browser build, hardware acceleration, power mode and network profile.

## Provisional budget hypotheses

| Metric | Hypothesis only | Gate |
| --- | --- | --- |
| Combined Brotli transfer bytes (quad WASM + local JS) | At most 500 KiB | **Not enforced** |
| 60 Hz target browser frame interval p95 | At most 16.7 ms | **Not enforced** |
| Cold startup to first presented frame | Select only after device and network calibration | **Not enforced** |
| p95 CPU frame time, GPU stall duration, input latency | Establish baselines before setting thresholds | **Not enforced** |

A CI-host p95 frame interval above 16.7 ms is not automatically a product
failure, because the runner is not a reference consumer device. Likewise,
compressed bytes are not proof of startup latency.

## Comparison rules for future optimization PRs

1. Record baseline and candidate Git SHAs, executable WASM/JS SHA-256 values,
   browser/Node/OS versions and fixture identity.
2. Run both candidates under the **same** benchmark environment and settings.
3. Report raw differences, percentage deltas, p50/p95/p99 distributions,
   sample size, dispersion and confidence or other uncertainty measure.
4. Confirm functional parity via Rust/Node integration and all three
   Playwright browser engines before promoting an optimization.
5. State any increased memory usage, platform risk or runtime complexity.
6. Preserve the decision and run URLs even for experiments that are rejected.
7. Escalate an SLI to an enforced SLO only after a separately reviewed
   calibration and release-policy change.

## Evidence collection and retention

The required integration job publishes
`browser-performance-baseline` (14-day retention), including
`test-results/build-size-receipt.json` and Playwright attachment files.
The workflow's source head SHA, CI run ID and browser project accompany
the metric. Keep the PR/issue links as a durable receipt after the temporary
artifact expires. Do not copy numbers without their actual execution record.

The goal of this phase is honest baseline instrumentation. This document
does **not** claim GPU performance improvements, full mobile browser support
or an SLO-compliant release.
