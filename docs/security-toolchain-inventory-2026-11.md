# Toolchain and dependency security inventory

* Review date: 2026-11-10
* Scope: Security-reviewed workflow action updates from official release tags
* Writing review: STE-aligned draft
* Review status: **Partial inventory, not a complete vulnerability audit**

## GitHub Actions

The following SHAs were resolved from the stated upstream GitHub tag references on 2026-11-10.
These were the latest non-prerelease tags reported by each upstream GitHub Releases API on the review date.
A SHA identifies the action code. It does not prove that code is free of security faults.

| Action | Source tag | Pinned commit |
| --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/cache` | `v6.1.0` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| `actions/upload-artifact` | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |

The cache restore and save actions use the same `actions/cache` commit.
The workflow uses full SHAs for all `uses:` action references.
Run `node scripts/check-actions.mjs` to check for mutable action references.
The manual compatibility workflow no longer uses the unmaintained `actions-rs/toolchain` and `actions-rs/cargo` actions.
It uses `rustup` and `cargo` directly.

## Rust

The library declares these dependencies in `Cargo.toml`:

| Scope | Dependency | Declared version |
| --- | --- | --- |
| Linux and Android | `libc` | `0.2` |
| Windows | `winapi` | `0.3` |
| Android | `ndk-sys` | `0.2` |
| Apple platforms | `objc-rs` (package alias `objc`) | `0.2` |
| Development | `glam` | `0.24` |
| Development | `quad-rand` | `0.1` |
| Development | `fontdue` | `0.8` |

The Rust minimum supported version is **1.70**.
The normal CI uses `stable`, which is not an immutable compiler version.
The manual workflow also uses a moving stable compiler for compatibility builds.
There is no committed `Cargo.lock`.
For a library, the lockfile policy needs a separate review.
**Exact resolved crate versions and RustSec advisory results are not yet recorded.**

## JavaScript and browsers

The development-only npm dependencies are pinned through `package-lock.json`.
The direct versions declared in `package.json` are:

| Dependency | Declared version |
| --- | --- |
| ESLint | `10.14.0` |
| Playwright test | `1.56.1` |
| PNGJS | `7.0.0` |

CI uses Node.js **24** on Ubuntu **24.04**.
The Playwright package selects browser revisions from its own metadata.
The required PR lane runs Chromium. Firefox and WebKit use a manual test lane.
No runtime npm package is bundled into the WASM application.

A security workflow run on `master` found **three moderate npm advisory paths** through `minimatch` 10.2.6: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The high-severity threshold passed, but that did **not** mean no findings.
A correction in this PR overrides the development-only `minimatch` dependency to patched version `11.0.1`.
The one-shot lockfile generation CI verified `npm audit --package-lock-only --audit-level=moderate`, `npm ci`, ESLint and Node tests on the branch.
Confirm the required PR-head checks and the post-merge advisory run before declaring this correction complete.

The RustSec scan in [run 42799699457](https://github.com/Tigon32/miniquad/actions/runs/42799699457) loaded 1,430 advisories and scanned 24 resolved crates.
It reported no blocking Rust vulnerabilities but flagged `ttf-parser` 0.20.0 as **unmaintained** under [RUSTSEC-2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192).
The parser is brought in through the `fontdue` development/example dependency.
The advisory lists no patched release. Replacing that parser requires a separate compatibility review.
Do not suppress the warning or describe it as a confirmed exploitable vulnerability.

## External assets and runner inputs

* `docs/terminology/miniquad.json` references the independent shared terminology registry at commit `0e755947aed328d5287e19e2f4adf0e46ae0549b`.
* The manual Android workflow uses `notfl3/cargo-apk` without a digest pin. Treat it as an unresolved supply-chain risk.
* GitHub-hosted runner images and `rustup stable` can change between runs.
* No external browser JavaScript CDN is required for the checked-in `js/gl.js` fixture.

## Required next checks

1. Run `npm audit --audit-level=high` against the lockfile. Review each finding.
2. Run the scheduled or manual `Security advisory review` workflow. It installs `cargo-audit` 0.22.2 with `--locked`, generates a temporary `Cargo.lock` and scans the resolved Rust dependency graph against RustSec. Record the actual scan output and advisory database revision before declaring this work verified. This scan has **not run** as part of this document update.
3. Review the Android image. Replace it with a digest-pinned image or a reviewed native build.
4. Check support and advisories for Node, ESLint, Playwright, Rust, and all third-party Actions.
5. Review `pull_request_target` token access and test that untrusted PR code cannot execute.
6. Record the security-check results in issue #16 before claiming full completion.

## References

* [MADR 0007](adr/0007-use-supported-and-secure-toolchains.md)
* [Security policy](../SECURITY.md)
* [Issue #16](https://github.com/Tigon32/miniquad/issues/16)
* [GitHub guidance for secure Actions](https://docs.github.com/en/actions/reference/security/secure-use)
