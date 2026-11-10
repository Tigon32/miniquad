---
name: miniquad-performance-proof
description: Measure Miniquad performance with repeatable tests and check that an optimization does not change required behavior.
---

# Prove a performance change

Use this skill for WASM size, browser startup, CPU work, GPU drawing, and memory use.
Read [issues #12](https://github.com/Tigon32/miniquad/issues/12), [#14](https://github.com/Tigon32/miniquad/issues/14), and [#15](https://github.com/Tigon32/miniquad/issues/15).

## Procedure

1. State the result that you want to improve.
2. Select one unit and one test workload.
3. Record the source revision, compiler flags, browser, OS, GPU, and device.
4. Run the old program. Confirm that it produces the correct output.
5. Find what limits its performance. Use a profile from a separate run.
6. Make one small change.
7. Run the new program with the same workload and settings.
8. Confirm that both programs produce equal results.
9. Run paired measurements. Alternate the old and new versions when possible.
10. Record the number of runs, the median, and the result spread.
11. Check memory, errors, startup, and rendering for a new problem.
12. If measurement noise is as large as the change, report **inconclusive**.
13. Record the data and the test method in the PR.

## Measurements

Use the measurements that apply to the change:

* Compressed WASM and JavaScript transfer size, in bytes.
* Time from start to first rendered frame, in milliseconds.
* Frame interval and input latency, in milliseconds.
* JS heap and WASM memory use, in bytes.
* GPU resource use, if the device gives reliable data.

Do not report a GPU timing from an API that returns a fixed zero.
Do not set a release limit from a guessed baseline.
Do not claim a speed gain without measured results.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
