# Use risk-based tests and selective TDD

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Miniquad Rust, JavaScript, WebAssembly, WebGL, and native code
* Related issues: [#8](https://github.com/Tigon32/miniquad/issues/8), [#9](https://github.com/Tigon32/miniquad/issues/9), [#10](https://github.com/Tigon32/miniquad/issues/10), [#11](https://github.com/Tigon32/miniquad/issues/11), [#16](https://github.com/Tigon32/miniquad/issues/16), [#21](https://github.com/Tigon32/miniquad/issues/21), [#25](https://github.com/Tigon32/miniquad/issues/25)

## Context and Problem Statement

Miniquad uses Rust, a JavaScript browser bridge, and native interfaces.
The compiler and linter can find some errors.
They cannot show that all input, rendering, and resource functions work.

Strict test-driven development (TDD) for every small change can take too much time.
No tests can let old bugs return.
We need a test method that fits the risk of each change.

## Decision Drivers

* Find errors at the interface where they occur.
* Keep required CI checks fast and stable.
* Test what a user can observe.
* Use actual browsers for browser behavior.
* Keep test dependencies out of the game download.
* Record the tests that ran and the tests that did not run.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Compiler checks and review only | Fast feedback | The checks miss runtime errors |
| Strict TDD for all changes | Tests guide every change | GPU and native tests can be slow or difficult |
| **Risk-based tests with selective TDD** | Focus effort on important faults | Each PR needs a risk review |

## Decision Outcome

**Proposed:** Select tests from the risk and the type of change.
Use test-first development for a verified bug when a repeatable test is possible.
Do not require strict TDD for a document change.

### Select the tests

| Change | Required evidence |
| --- | --- |
| Verified bug | Show the old failure. Add a test that fails before the fix and passes after it. |
| JS/WASM ABI or external input | Test exact bytes, length, ownership, invalid input, and error results. Use compiled WASM for memory claims. |
| Browser and WebGL behavior | Test real browsers. Use a mock only for isolated logic. |
| Native interface | Test the applicable OS when you make a native behavior claim. Record OS targets that were not tested. |
| Pure Rust function or voxel algorithm | Test correct outputs and limits. Use property tests when useful. |
| Performance change | Set a metric before the change. Test equal output. Compare repeatable measurements. |
| Document change | Check links, terms, technical facts, and required CI. A new behavior test is not necessary. |
| Prototype | Keep it separate. Add acceptance tests before it becomes a supported feature. |

### Use test layers

1. **Unit tests:** Test small functions and stable results.
2. **Contract tests:** Test JS/WASM imports, exports, encoding, and ownership.
3. **BDD tests:** Use Given–When–Then scenarios for required user behavior. Connect each scenario to executable checks. See [#25](https://github.com/Tigon32/miniquad/issues/25).
4. **Browser tests:** Test the real WASM application in supported browsers. A mock is not a browser test.
5. **Native tests:** Use the required OS and GPU when the result depends on them.
6. **Benchmark tests:** Use a fixed workload. Record the source revision, environment, units, and result spread.

### Required CI

The PR test lane must run the approved Rust, WASM, JavaScript, and regression checks.
Add browser smoke tests to this lane after the tests are stable.
Keep long fuzz runs, full platform checks, and repeated benchmarks in a manual or scheduled lane.
Run the applicable deep lane before a release or a high-risk change.

If a test fails, do not hide the result.
If a test is unstable, record the cause and a follow-up issue.
A skipped test is not a passed test.
Do not use a code coverage percentage as proof that the software is correct.

### Required PR record

For each code change, give:

1. The related issue and source revision.
2. The changed behavior and the risk.
3. The exact tests and their results.
4. The browsers or OS targets that ran.
5. The important tests that did not run.
6. The action to reverse the change if it causes a fault.

Do not close an issue until its acceptance conditions have evidence.
Do not say that a mock test proves WebGL behavior or Rust memory safety.
Keep test dependencies out of the production browser download.

### Default work sequence

1. Understand the contract.
2. Identify the risk.
3. Reproduce a known bug.
4. Select the smallest useful test.
5. Make the change.
6. Run the required checks.
7. Test the real boundary when necessary.
8. Record the evidence.
9. Merge with the project rules.
10. Close the issue only when all conditions pass.

## Consequences

### Positive

* Important bugs get repeatable tests.
* Small editorial changes need less test work.
* Browser and native claims use real execution evidence.

### Negative

* A reviewer must select the correct tests.
* Some OS and GPU tests can take more time.
* The first test harnesses need implementation work.

## Confirmation

1. Apply this method to a JS/WASM bug, a loader fault, and a document change.
2. Check that tests find the old fault.
3. After approximately 10 scoped PRs, review missed bugs, unstable tests, and CI time.
4. Change this policy in a new MADR if the results show a problem.

## References

* [MADR 0001](0001-use-madr-and-ubiquitous-language.md)
* [MADR 0003](0003-use-asd-ste100-for-communication.md)
* [Agent instructions](../../AGENTS.md)
* [Gap analysis](../gap-analysis-2026-11.md)
