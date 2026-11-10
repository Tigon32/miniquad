# Adopt risk-based verification with selective test-first development

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Miniquad Rust library, JavaScript/WebAssembly ABI, WebGL rendering and native platform backends
* Related issues: [#8](https://github.com/Tigon32/miniquad/issues/8), [#9](https://github.com/Tigon32/miniquad/issues/9), [#10](https://github.com/Tigon32/miniquad/issues/10), [#11](https://github.com/Tigon32/miniquad/issues/11), [#16](https://github.com/Tigon32/miniquad/issues/16), [#21](https://github.com/Tigon32/miniquad/issues/21), [#25](https://github.com/Tigon32/miniquad/issues/25)

## Context and Problem Statement

Miniquad is a lightweight, mostly Rust rendering/window/input abstraction with a hand-written JavaScript/WebAssembly bridge, WebGL resource management and native platform adapters. The existing CI builds Rust/WASM and lints JavaScript, but compile/lint success does not prove actual behavior. The initial source audit found legacy edge cases, incomplete APIs and unsafe ownership contracts.

Uniform strict test-driven development (TDD) for every small edit is expensive and difficult for GPU/OS integration. Conversely, ad hoc manual verification or tests added only after a release can leave regressions undiscovered. How should we choose **what** to test, **where** to test it and **when** test-first is warranted, without disproportionately increasing toolchain size, CI time, maintenance or false confidence?

## Decision Drivers

* Catch correctness, memory-ownership, availability and compatibility regressions at their closest meaningful boundary.
* Keep the quick required pull-request lane reliable, reproducible and affordable.
* Prioritize observable behavior and supported contracts over test counts or implementation details.
* Allow small, isolated platform-dependent changes without demanding a full browser/native matrix on every commit.
* Make issue closure and automatic merging evidence-based, not dependent on a green compiler alone.
* Preserve a small runtime download: test dependencies must not ship in browser artifacts.
* Give coding agents unambiguous acceptance and failure reproduction expectations.

## Considered Options

| Option | Advantages | Costs / risks | Disposition |
| --- | --- | --- | --- |
| **No standardized tests; rely on compilation, lint and manual review** | Lowest immediate effort | Bugs in WASM data transfer, events, GPU state and failure paths remain invisible; regressions recur | Rejected |
| **Strict red–green–refactor TDD for every code change** | Strong immediate feedback and often good unit-level design | Brittle GPU/DOM mocks, high friction for spikes/refactoring, pressure to test implementation details; platform behavior still needs real execution | Rejected as universal rule |
| **Risk-based test pyramid with selective test-first regression and behavior-driven scenarios** | High confidence where failures matter, fast tests for most PRs and targeted runtime qualification | Requires thoughtful risk/coverage triage and upkeep of fixtures | **Proposed** |

## Decision Outcome

**Proposed:** Adopt **risk-based verification**, using **test-first development for proven bugs and high-risk contracts**, not strict TDD for every edit. Tests must demonstrate the behavior they claim and fail when the defended behavior breaks.

### 1. Test selection by change class

| Change class | Required before PR completion | When to use test-first / TDD |
| --- | --- | --- |
| **Verified defect** | Reproduce old failure; add a regression that fails against the old implementation and passes after the fix; retain it in CI | **Required** when a deterministic harness is feasible. If reproduction is only possible on native hardware or cannot run in CI, record a concrete blocker and capture evidence rather than inventing a fake red test |
| **Rust ↔ JavaScript/WASM ABI, allocations, clipboard, files, inputs, parsing and versioning** | Unit/contract tests at the boundary for normal, invalid, Unicode, empty and failure inputs, plus compiled-WASM verification for ownership claims | **Strongly preferred**, especially for dangerous or externally supplied input |
| **WebGL rendering, context loss, frame lifecycle, browser focus and interaction** | Fast isolated state/logic tests **and** actual WebGL/browser integration/BDD acceptance where a claim is about runtime | Write the behavior/scenario before implementation; allow an exploratory spike first when hardware/browser behavior is unknown |
| **Native OS/FFI backend** | Focused contract tests where possible, target build, and real supported OS verification for claimed native behavior; explicitly list untested OS targets | Test-first for deterministic callbacks/state conversion; exploratory reproduction for driver/OS-dependent behavior |
| **Pure Rust algorithm / voxel mesher / serialization** | Deterministic unit or property tests for invariants and boundary cases, with optional differential/reference fixtures | Prefer test-first for stable input/output behavior |
| **Performance optimization** | Correctness parity against a baseline and repeated comparable measurements; prevent meaningful regressions | Establish a benchmark and outcome/threshold **before** optimizing; do not insist on synthetic unit-test-first for a measured bottleneck |
| **Documentation, editorial or trivial structural changes** | Link/source validation and relevant existing checks; no new behavioral test unless behavior/contract changes | **Optional**; avoid ceremony for no behavior change |
| **Exploratory prototype / unsupported feature spike** | Isolated branch, explicit non-goals, manual evidence and expiry/cleanup decision; no production merge until acceptance tests exist | Optional during the spike; **required tests before promotion** into supported API |

### 2. Where tests belong (fast-to-real layered verification)

1. **Unit/property tests** beside pure Rust logic and deterministic helpers. Assert public invariants and externally observable results, not private implementation details. Seed fuzz/property inputs; minimize and retain failures.
2. **Boundary/contract tests** for JS/WASM imports/exports, pointer/length/UTF-8 ownership and event sequencing. Use the *actual shipped* `js/gl.js` where practical; a mock may confirm marshaling but is **not** proof of Rust memory safety or WebGL behavior. Compiled WASM fixtures must back those claims.
3. **Behavior-driven (BDD) browser tests** with readable Given–When–Then acceptance scenarios for critical user-visible flows. Reuse a small catalogue, map each scenario to executable assertions, and avoid a heavy Gherkin dependency until justified. Cover success **and negative** cases.
4. **Native and GPU qualification** on a targeted real platform or manually dispatched compatibility matrix. Desktop WebKit ≠ iOS Safari; compiling for Windows ≠ observing the Windows event loop.
5. **Performance regression checks** only with a calibrated workload and variability; noisy device/CI timing should be informational, not an arbitrary blocking threshold.

### 3. CI policy and evidence

* **Required PR fast lane:** Rust library checks/tests, one release WASM example, JavaScript syntax/lint, deterministic JS/ABI tests and a minimal real-browser smoke suite **once implemented and proven stable**. Introduce tests incrementally; do not claim absent jobs pass. Gate on the *exact PR head* and record count/commands.
* **Manual or scheduled deep lane:** cross-platform builds and runtime hardware tests, extended browser compatibility, fuzz campaigns, GPU context-loss workloads, dependency advisory scans, and repeated benchmarks. A manual lane must run for a relevant release or high-risk change, not be silently treated as passing because it wasn't triggered.
* **Changed-risk targeting:** every PR declares impacted surfaces and the tests that exercise them. A targeted test may replace a giant per-PR matrix when risk is bounded; it cannot replace a required baseline check.
* **Failures:** do not turn failing checks into ignored tests, broad lint suppressions, skip flags or fake passes. Quarantine flaky tests with an owner, reproducible symptom, expiry date and follow-up issue; preserve visibility.
* **No arbitrary coverage percentage gate.** Track behaviors and regression classes actually defended, including meaningful negative paths. Coverage counts are diagnostics, not proof of correctness.
* **Issue/PR receipt:** issue link, source SHA, failing-before-fix evidence where applicable, exact test commands/results, browser/OS versions when used, and known untested cases. No claim that a merged change is runtime-qualified until the necessary runtime tests passed.
* **Testing dependencies:** keep test-only crates/npm packages off the production browser download; require reviewed pinned versions and reproducible installation.

### 4. Default engineering loop

`Understand contract → classify risk → reproduce if a bug → choose cheapest meaningful test → implement minimally → run fast checks → verify real boundary as applicable → capture evidence → merge through protected PR → close accepted issue`.

The developer may write tests **before** an implementation for a bug/ABI change, or write isolated tests **alongside** a genuinely exploratory implementation. The required outcome is evidence of behavior, not the temporal order in which files were edited.

## Consequences

### Positive

* High-risk ABI, memory and input bugs receive early, repeatable regression protection.
* Small documentation and routine refactoring work avoids mechanical TDD overhead.
* Browser- and native-only claims are supported by actual platform execution rather than mocked confidence.
* BDD scenarios provide stakeholder-readable contracts without adding a large runtime framework.

### Negative

* Risk classification requires review and may initially be inconsistent.
* Some integration/hardware regressions remain detectable only in targeted manual lanes until automation exists.
* Baseline harness construction is front-loaded and may make early PRs slower.
* The organization must maintain scenario relevance, not just an increasing test count.

## Confirmation

* Exercise this policy on three changes: a JS/WASM encoding defect (#8), a browser loader failure (#15), and a non-behavioral documentation change. Check the evidence receipts and time spent.
* Review whether required PR checks run the expected tests and whether a known bad edit makes the relevant test fail (mutation-style sanity check on a safe isolated branch).
* After ~10 scoped PRs, review escaped defects, flaky test rates, CI wall time, and whether the selected tests gave useful signal. These are **future measurements**, not established metrics.
* Revise the policy with a superseding ADR if actual evidence shows unbalanced cost or risk.

## References

* [Existing MADR convention](0001-use-madr-and-ubiquitous-language.md)
* [Project-local test and delivery skills](../../AGENTS.md)
* [Bounded gap analysis](../gap-analysis-2026-11.md)
* [BDD acceptance issue #25](https://github.com/Tigon32/miniquad/issues/25)
