# Use fork-scoped browser release candidates with a measured regression guard

* Status: **Proposed**
* Date: 2026-11-11
* Scope: Fork release labels, candidate packages, rollout and rollback exercise, regression guard, and candidate gate
* Related issue: [#19](https://github.com/Tigon32/miniquad/issues/19)
* Related decisions: [MADR 0005](0005-low-cost-ci-and-risk-based-test-lanes.md), [MADR 0006](0006-distinct-project-identity-and-upstream-attribution.md), [MADR 0009](0009-optional-browser-adoption-layer.md)
* Executable details: [release candidate contract](../release-candidate-contract.md)
* Writing review state: **STE-aligned draft**

## Context and Problem Statement

Consumers need one supported source for the Rust crate, the browser bridge, and the WASM file.
The fork has no tag and no published release.
The [release policy](../release.md) requires a candidate, a rollback exercise, and calibrated regression limits.
It does not give a release label, a package format, or a regression rule.

Four facts control this decision:

1. The fork contains upstream Miniquad master `39c928fb7e09fd44e45f37fe9a98503968bca412`.
   That commit has `Cargo.toml` version `0.4.11`. Upstream has no `v0.4.11` tag.
2. Upstream `js/gl.js` at that commit has `const version = 2;`.
   The fork `js/gl.js` has `const version = 3;` and rejects a different WASM ABI version.
   A consumer that pairs an upstream bridge with a fork WASM file fails at startup.
   The Rust public API has no observed signature removal in `src/lib.rs`, `src/event.rs`, and `src/graphics.rs`.
3. The generator `scripts/create-browser-project.mjs` reads its templates from its own working tree.
   It reads the browser assets from the selected Git revision.
   The generated `web/MANIFEST.json` contains `generatedAt` and `updatedAt` timestamps.
4. A WASM file built from the current starter contains absolute local source paths in panic location strings.
   A shipped artifact must not contain a local path.

No previous qualified release exists.
The SLI policy has no calibrated SLO.
The shared macOS development computer is not a controlled measurement host.

## Decision Drivers

* Do not imply an upstream release or upstream endorsement.
* Do not select a new product name. MADR 0006 controls that choice.
* Keep the crate name `miniquad`, the root dependency graph, ABI v3, and the upstream credit.
* Make each shipped byte traceable to one immutable, reviewed commit.
* Use only Node.js built-in modules, Git, Cargo, the pinned Playwright `1.56.1`, and `pngjs` `7.0.0`.
* Fail closed when evidence is missing.
* Do not use guessed numerical budgets.
* Keep expensive measurement out of each pull request.

## Considered Options

### Release label

| Option | Result |
| --- | --- |
| `v0.4.11` or `0.4.11` | **Rejected.** It looks like an upstream release. |
| `0.4.11-tigon32.1.rc.1` | **Rejected.** The core `0.4.11` claims upstream browser protocol compatibility. The bridge protocol changed from version 2 to version 3. |
| `0.4.11+tigon32.1` (build metadata) | **Rejected.** SemVer ignores build metadata for precedence. The label cannot order fork releases. |
| Change `Cargo.toml` `version` now | **Rejected for candidates.** It changes the package identity that MADR 0006 controls. Owner selection is necessary. |
| **Fork label `X.Y.Z-tigon32.F.rc.R`, Git tag prefix `tigon32-miniquad-v`** | **Selected.** The tag is fork-scoped. The core version states compatibility. SemVer precedence is correct. |

### Candidate package

| Option | Result |
| --- | --- |
| Copy the current `web/` directory | **Rejected.** It keeps timestamps, can include local paths, and can use current templates for an old revision. |
| Generate from the current working tree for any revision | **Rejected.** The templates do not come from the selected revision. |
| **Materialize the selected commit with `git archive` and run its own generator and build script** | **Selected.** The selected commit controls the templates, the generator, the bridge, and the Rust source. |

### Regression guard host

| Option | Result |
| --- | --- |
| Fixed targets such as 500 KiB or 16.67 ms | **Rejected.** They are hypotheses, not measurements. |
| Shared macOS development computer | **Rejected as the gate host.** The host load is not controlled. A local run is a rehearsal only. |
| Twenty or more repetitions in each pull request | **Rejected.** It is too expensive for each pull request. MADR 0005 requires low-cost lanes. |
| **One manual GitHub-hosted `ubuntu-24.04` job that builds both packages and runs paired, alternating measurements** | **Selected.** One job gives one software profile for baseline and candidate. It is a reference profile, not a device SLO. |

### Regression rule

| Option | Result |
| --- | --- |
| Absolute targets | **Rejected.** No calibration data supports them. |
| Mean difference with a t-test | **Rejected.** Frame and startup times are not normally distributed. |
| **Baseline nearest-rank p90 plus one observed timer step, compared with the candidate median and its distribution-free confidence interval** | **Selected.** The rule uses the observed baseline distribution. It needs only sorting and binomial arithmetic. |

## Decision Outcome

**Proposed.** Use the contract in [release-candidate-contract.md](../release-candidate-contract.md).
The main rules follow.

### Version and tag

* A fork release label is `X.Y.Z-tigon32.F.rc.R` for a candidate.
  A future approved publication uses `X.Y.Z-tigon32.F.release`.
  The `.release` form is reserved. This decision does not approve its use.
* The Git tag is `tigon32-miniquad-v` followed by the label.
  The prefix names the GitHub owner and the current crate. It is not a product name.
* `X.Y.Z` is the fork compatibility version.
  Start from upstream `0.4.11`. While the major version is `0`, a breaking change to the Rust public API or to the core browser contract increases the minor version and sets the patch version to `0`.
  An additive or corrective change increases the patch version.
* The first candidate label is `0.5.0-tigon32.1.rc.1`.
  The reason is the observed bridge protocol change from version 2 to version 3.
* `Cargo.toml` keeps `name = "miniquad"` and `version = "0.4.11"` for candidates.
  The candidate record states this difference. A `.release` publication requires an owner decision about the package version.
* Optional companions, the embedding module, and the starter parameter surface keep their own versions.
  A candidate records them. It does not join them to the core version.
* Each candidate records the upstream merge base, the upstream package version, and the imported upstream changes.
  An upstream synchronization goes through an integration PR. A clean merge is not compatibility evidence.

### Candidate package and provenance

* Build each package from a full 40-character commit SHA that is an ancestor of `origin/master`.
* Run the generator and the build script of that commit. Record the tool commit separately.
* Remap local paths in the WASM build. Reject a payload that contains a local path or a credential pattern.
* Move build timestamps to a separate timing receipt. Keep a canonical payload manifest without timestamps.
* Record SHA-256, raw bytes, gzip level 9 bytes, and Brotli quality 11 bytes for every shipped file.
* Write new files only. Do not overwrite. Do not delete.

### Rollout and rollback exercise

* Serve the baseline and candidate packages from one owned `127.0.0.1` server with an ephemeral port.
* Deploy the baseline, then the candidate, then the exact baseline again.
* In Chromium, Firefox, and desktop WebKit, check served hashes, browser-received hashes, ABI version 3, and canvas pixels.
* Keep the screenshots and error logs.

### Bootstrap baseline

The first candidate uses `f837a98d415262320a8c66ef9f8024d8f2faeab1` as a **bootstrap reference**.
At that commit, a local run passed 141 Playwright tests in Chromium, Firefox, and desktop WebKit.
That commit is **not** a qualified release.
The first rollback exercise proves the rollback procedure and package integrity.
It does not prove a return to a qualified state.
When a `tigon32-miniquad-v*.release` tag exists, the gate rejects a bootstrap rollback target.

### Regression guard

* The reference profile is one manual GitHub-hosted `ubuntu-24.04` job with pinned Playwright browsers.
  Chromium runs headless with SwiftShader. Firefox and WebKit run under `xvfb-run`, as in the existing browser matrix.
* The job builds both packages before measurement. It runs at least 20 alternating baseline and candidate pairs for each engine.
* The budget for each gated metric is the baseline nearest-rank p90 plus one observed timer step from the same job.
* The candidate passes a metric when its median is at or below the budget.
  It fails when the lower confidence bound of its median is above the budget.
  Other results are inconclusive. An inconclusive result blocks the gate.
* GPU memory, JavaScript heap, input latency, physical devices, and network latency have `null` values with a reason.
* A local run on the shared macOS computer is a rehearsal. It cannot satisfy the regression guard.

### Gate

The gate result is `QUALIFIED-CANDIDATE`, `BLOCKED`, or `FAILED`.
Missing CI, ABI, browser, rollback, regression, security, change log, or approval evidence gives `BLOCKED`.
`QUALIFIED-CANDIDATE` applies only to the recorded reference profile and engines.
It is not a release approval. A `.release` publication needs a separate owner approval.
Native platforms stay **unqualified** unless a separate evidence record exists for each target.

## Consequences

### Positive

* Consumers get one immutable source, one deployable payload, and one hash list.
* The label does not claim upstream compatibility that the fork does not have.
* The regression guard uses measured data and a written rule.
* Pull requests do not pay for the measurement job.

### Negative

* The label core `0.5.0` and the package version `0.4.11` differ until the owner decides.
* A future upstream `0.5.0` can have the same core numbers. The `tigon32` identifiers keep them separate.
* The regression guard is relative to the baseline. It is not an absolute product objective.
* Results from a GitHub-hosted runner do not describe user devices.
* The first rollback target is not a qualified release.

## Confirmation

1. Unit tests prove the label grammar, the precedence order, the compatibility rule, the manifest rules, the leak scan, and the statistics.
2. Two package builds of the same commit in two new directories give identical payload bytes.
3. The rollout and rollback exercise passes in Chromium, Firefox, and desktop WebKit, with retained screenshots.
4. The manual reference-profile job retains the raw samples and the regression result.
5. A reviewer records the gate decision in the candidate evidence record.
6. This decision stays proposed until that evidence is reviewed and merged.

## References

* [Release qualification policy](../release.md)
* [Browser performance SLI policy](../browser-performance-sli-policy.md)
* [Candidate evidence template](../release-evidence/TEMPLATE.md)
* [Upstream attribution](../upstream-attribution.md)
* [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)

**Writing review:** STE-aligned draft. Full dictionary review not done.
