# Use supported and secure development tools

* Status: **Accepted**
* Date: 2026-11-10
* Scope: Rust, JavaScript, browser tests, dependencies, CI actions, runners, and agent tools
* Writing review state: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

## Context and Problem Statement

Development tools and dependencies can contain security faults.
Some faults are public before a corrected version is available.
An unsupported version can stop receiving security corrections.
A new release can also break the project's API or test environment.

The project must use supported tools and correct known security faults.
It must also keep builds repeatable and CI costs low.

## Decision Drivers

* Use versions that receive security maintenance.
* Check published security information from authoritative sources.
* Respond quickly when a security fault affects this project.
* Keep exact source revisions and reproducible test results.
* Avoid automatic major-version changes without compatibility tests.
* Protect CI credentials and privileged workflows.
* Keep the production Rust/WASM footprint small.
* Preserve the Rust minimum supported version until a separate decision changes it.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep all current versions | Few changes | Unsupported or vulnerable code can remain |
| Update everything to the newest release automatically | Fast updates | Can break compatibility and include unreviewed changes |
| **Use the newest supported, security-reviewed compatible versions** | Security maintenance with controlled change | Requires ongoing review and evidence |

## Decision Outcome

**Accepted:** Use supported versions of development tools and dependencies.
Prefer a current security-maintained version that passes the project's compatibility tests.
Do not use the version number alone as evidence of security.

### Inventory and version rules

1. List the Rust toolchains, compiler targets, crates, npm packages, browser tools, GitHub Actions, runner images, and external scripts in use.
2. Record the installed version, supported-version policy, source, owner, and review date.
3. Keep `package-lock.json` and use `npm ci --ignore-scripts` in ordinary CI.
4. Review whether a `Cargo.lock` file is correct for this **library**. Do not commit it as a release requirement without that decision.
5. Set the supported Rust toolchain independently of the minimum supported Rust version in `Cargo.toml`.
6. Keep the WASM target and real browser test working after every relevant update.
7. Pin third-party GitHub Actions to reviewed, immutable commit SHAs. Record the upstream release used to select each SHA.
8. Pin external scripts, agent skills, and cross-repository resources to a reviewed revision. Do not execute a moving branch without review.
9. Use an explicit runner image. Review its end-of-support date and installed dependencies.
10. Record the Playwright version and the browser revisions it installs. Invalidate caches when those revisions change.

### Security information

Check the applicable sources during reviews:

* [RustSec advisory database](https://rustsec.org/) and [cargo-audit](https://github.com/rustsec/rustsec).
* [GitHub Advisory Database](https://github.com/advisories), npm security advisories, and upstream package notices.
* Official Rust, Node.js, ESLint, Playwright, browser, Ubuntu runner, and GitHub Actions support notices.
* Vendor advisories and applicable [CISA Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) entries.

A scanner result is **not** proof that all code is secure.
A new advisory needs an applicability review.
Do not claim that a flaw is exploitable without evidence.

### Update policy

* **Routine review:** Check support status and applicable advisories at least once each month.
* **Before release:** Review the inventory again. Record known risks and the source revisions.
* **Active exploitation or critical applicable advisory:** Start triage within 24 hours of discovery. Limit access or disable the affected function when necessary.
* **Security correction:** Apply an available, tested correction as soon as practical. If no correction exists, record a mitigation and a review date.
* **Major updates:** Use a small PR. Test affected API, browser, native, and build behavior before merge.
* **Unsupported components:** Replace them or record a temporary exception with an owner, reason, risk, and expiry date.

Do not hide a failed security test to keep CI green.
Do not use an untrusted dependency update to bypass a required check.

### CI and access rules

1. Keep routine test jobs at `contents: read`.
2. Allow write permission only in a separate, justified trusted job.
3. For `pull_request_target`, do not check out or execute code from an untrusted PR head.
4. Preserve required status checks and branch rules. Do not approve or merge by bypass.
5. Cache downloaded packages only with versioned keys. Never cache credentials or treat cached binaries as trusted by default.
6. Use the small required CI lane in [MADR 0005](0005-low-cost-ci-and-risk-based-test-lanes.md).
7. Keep full cross-platform tests and extended scans on a scheduled, manual, or release lane when cost requires it.
8. Run focused advisory checks as part of the agreed security gate. Record any platform or database coverage limits.

### Required change evidence

Each security or toolchain PR must record:

1. The old and new versions and exact revisions.
2. The support or advisory source and date.
3. Whether the change affects production code, developer tools, or CI.
4. The affected interfaces, known compatibility risks, and dependency impact.
5. The tests run, their results, and the checks not run.
6. Any remaining advisories, temporary exceptions, and rollback action.

An advisory without a fixed version does not justify a fabricated clean result.
A passing browser smoke test does not prove that every target platform is secure.

## Consequences

### Positive

* The project stops treating unsupported tools as acceptable defaults.
* Security changes get clear priority and review evidence.
* Exact revisions make tool and CI changes easier to reproduce.

### Negative

* Regular updates need reviewer time.
* An updated version can change behavior or download size.
* Some advisories have no immediate fix.
* Extra checks have a cost. They must follow the risk-based CI policy.

## Confirmation

1. Create a baseline inventory with exact versions and source links.
2. Check the current Rust, npm, CI, browser, and runner toolchain against support and advisory sources.
3. Replace unsupported or vulnerable versions in small, tested PRs.
4. Pin external GitHub Actions to reviewed commit SHAs.
5. Add focused advisory checks with explicit failure policy.
6. Record a review date and confirm the policy before each release.

This MADR sets a policy. It does **not** claim that the current toolchain has passed a security audit.

## References

* [MADR 0002 — Risk-based tests](0002-risk-based-verification-and-selective-tdd.md)
* [MADR 0003 — Controlled English](0003-use-asd-ste100-for-communication.md)
* [MADR 0005 — Low-cost CI](0005-low-cost-ci-and-risk-based-test-lanes.md)
* [Security issue #16](https://github.com/Tigon32/miniquad/issues/16)
* [Delivery issue #17](https://github.com/Tigon32/miniquad/issues/17)
