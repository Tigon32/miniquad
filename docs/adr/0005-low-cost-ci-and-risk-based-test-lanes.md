# Use low-cost CI with risk-based test lanes

* Status: **Accepted**
* Date: 2026-11-10
* Scope: CI for the Miniquad fork
* Writing review state: **STE-aligned draft**

## Context and Problem Statement

Miniquad needs reliable test results.
The project must also limit CI time, downloads, and hosted runner use.
A full browser and native platform matrix on every pull request can use many resources.
A compiler check alone cannot prove correct browser behavior.

How can CI find important faults at a reasonable cost?

## Decision Drivers

* Keep required PR checks short and repeatable.
* Use real browser execution for browser claims.
* Run extra browsers only when they add necessary evidence.
* Avoid repeated downloads and builds when possible.
* Keep dependencies and their versions fixed.
* Give clear results for failures and tests that did not run.
* Do not hide a failed test to reduce cost.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Compile and lint only | Low CI cost | Runtime faults can remain unknown |
| Full browser and OS matrix on each PR | Broad test coverage | High CI cost and long feedback time |
| **Small required lane and targeted deep lane** | Fast feedback with real runtime checks | The reviewer must select extra tests for some changes |

## Decision Outcome

**Accepted:** Use risk-based test lanes.

### Required PR lane

Run the existing `rust-wasm` check for each PR that targets `master`.

The check must include the applicable tests:

1. Compile and test the Rust library.
2. Check the WASM target and compile one release example.
3. Check JavaScript syntax and run the JavaScript regression tests.
4. Install JavaScript test tools from the committed lockfile.
5. Run ESLint.
6. Run one real Chromium smoke test of the compiled WASM example.

Do not install Firefox and WebKit for each PR.
Do not skip the required Chromium test because it fails.
Do not report a green test if no test ran.

### Deep test lane

Use `workflow_dispatch` to run the full browser matrix.
Run Chromium, Firefox, and WebKit against the same compiled example.
Use this lane before a relevant release and after changes that affect browser compatibility.
Run a specific native OS test when a change affects that OS.
Run performance tests on fixed workloads and hardware when the result is relevant.

A deep-lane test that did not run has status **not tested**.
Do not treat it as a passing test.

### CI resource controls

1. Use one checked-out source and one compiled WASM artifact for the browser tests in a job.
2. Keep development dependencies in a committed lockfile. Install npm packages with `npm ci`.
3. Use caches for Cargo packages/build results, npm downloads, and Playwright browser binaries. Key the caches by OS, architecture, and relevant dependency files.
4. Do not share a mutable cache without a versioned key. Do not download an unreviewed executable from a cache.
5. Use GitHub cache access rules. Do not store secrets, private data, or credentials in a cache. A cache is not a trusted software source.
6. Separate browser cache keys for the Chromium PR lane and the full browser test lane.
7. Use a fixed runner image and a fixed browser test version. Install only the necessary browsers.
8. Set `concurrency` for each workflow. Use the PR number to group PR runs. When a new run starts for that PR, cancel its old run.
9. Do not cancel an unrelated PR run. Keep manual release checks independent from normal PR cancellation.
10. Set a job time limit. Limit parallel jobs in the manual platform matrix.
11. Do not use `paths` filters to bypass a required PR check. A required check must always report its result.
12. Retain failure traces for a short fixed period. Upload only the files necessary to investigate a fault.
13. Use `contents: read` for tests. Do not give secrets or write tokens to code from an untrusted PR.
14. Review the cache hit rate, storage cost, and CI time after the first stable runs.
15. Do not hide a test failure, disable a required test, or claim a performance gain without evidence.

GitHub can schedule jobs in an unexpected order. The concurrency group cancels a previous run for the same PR when another run starts. It is not a proof that the newer commit always completes first.
Required checks and the protected branch rules must still apply to the exact PR head.

### Review controls

Use the changed files and risk to select extra tests.
A change to WebGL1 behavior can need Firefox or WebKit tests.
A change to a native callback can need the applicable native OS.
A change to an ABI contract can need a compiled-WASM browser test.
A documentation change must pass the current required checks but does not need a new browser test.

If a required check fails, correct the fault.
Do not remove the check or change it to optional without a new review.

### Cost measures

Record these measures from real workflow runs:

* Total required CI time per PR, in minutes.
* Browser download time and the bytes transferred, when available.
* Number of browser runs and test failures.
* Number of repeat runs necessary because of unstable tests.
* Number of defects that escaped to a later test lane.

The project has no approved numerical cost budget yet.
Use the first stable runs to set the baseline.
Make a new decision before you set a blocking cost limit.

## Consequences

### Positive

* Most PRs get a shorter test lane.
* The required lane includes real browser execution.
* Deep tests remain available when a change needs them.

### Negative

* A fault in another browser can remain unknown until the deep lane runs.
* Reviewers must identify changes that need more tests.
* Runner and browser versions need regular review.

## Confirmation

1. Run the required lane in Chromium.
2. Run the full browser matrix with `workflow_dispatch`.
3. Check that both runs use the same test behavior.
4. Compare CI time before and after the lane change.
5. Check that a known failing browser test stops a PR merge.
6. Review the policy after ten scoped PRs.

## References

* [MADR 0002 — Risk-based tests](0002-risk-based-verification-and-selective-tdd.md)
* [MADR 0003 — ASD-STE100 writing](0003-use-asd-ste100-for-communication.md)
* [Browser test issue #11](https://github.com/Tigon32/miniquad/issues/11)
* [CI governance issue #17](https://github.com/Tigon32/miniquad/issues/17)
