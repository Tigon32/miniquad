---
name: miniquad-performance-proof
description: Profile Miniquad WASM, JavaScript bridge and GPU frame performance; require comparable workloads and repeatable evidence before optimization claims.
---

# Measure, then optimize Miniquad

Adapted from pstack's benchmark checklist and limiter-first discipline; use for changes to Rust allocations, GPU buffer/texture use, build profiles, WASM size and JS loading. Read issues #12, #14 and #15.

1. **Claim and metric first.** Specify the decision, exact artifact and SLI (compressed `wasm` + JS transferred bytes, cold start to first successful draw, p95/p99 frame interval, input latency, peak JS/WASM heap or GPU resource count). Distinguish provisional targets from measured baselines.
2. **Verify equivalent behavior.** Both builds render the same scene, process the same inputs and have the same tested feature coverage. Missing rendering, errors or skipped work invalidate speed claims.
3. **Find the limiter.** Profile separately from timed runs; distinguish JS parse/compile, WASM instantiate, shader compilation, CPU frame update, GPU draw, network, memory allocation, device throttling and test-harness saturation. Name what actually limited the result; don’t infer from code aesthetics.
4. **Control comparisons.** Keep source/build flags, target features, browsers, hardware, DPR, input fixture, cache state, network throttling and renderer settings explicit. Tune meaningful knobs on *both* candidates. Use release artifacts, not debug vs release.
5. **Run matched repetitions.** Start with alternating A/B/A/B paired trials and collect enough observations to see distribution and variability. Prefer at least five paired runs for a screen; expand where noise approaches the improvement. Use median and spread; report p95 only with adequate sample count. No false precision or one-run winning claim.
6. **Check limits and end-to-end relevance.** Memory/GPU usage, error counts, stalls, startup and payload bytes must not regress unintentionally. Stop or label inconclusive when the measurement apparatus is saturated, runs failed or a changed component is below the noise floor.
7. **Ship the evidence.** Keep exact before/after hashes, commands/harness, metric units, tool/browser versions, result tables, noise, observed limiter, correctness parity, proposed decision and reversal trigger. Store concise reproducible receipts without private telemetry.

No workload or reference device is calibrated yet. Do not invent numeric SLO passes or call an optimized binary “smaller” until compressed transfer bytes are measured.
