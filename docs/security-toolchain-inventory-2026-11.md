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
| Isolated IME demo | `skrifa`, `zeno` | `0.48.0`, `0.3.3` |

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
* The unverified `notfl3/cargo-apk` container has been removed from the manual workflow. The Android backend remains **unqualified**. See [native platform qualification](native-platform-qualification.md).
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
* [IME font evaluation](font-renderer-evaluation-2026-11.md)
* [Issue #16](https://github.com/Tigon32/miniquad/issues/16)
* [GitHub guidance for secure Actions](https://docs.github.com/en/actions/reference/security/secure-use)

## Verification addendum — 2026-11-10

This section supersedes the older statements above that a RustSec scan had
not executed, that `fontdue` still occurred in the crate graph, and that the
Android container remained in the workflow. Keep the older statements as an
audit trail rather than silently rewriting historical observations.

* [Security scan 42855970374](https://github.com/Tigon32/miniquad/actions/runs/42855970374):
  RustSec, npm advisories, and Cargo licence checks passed on PR #66 head
  `ccb4a831d87459fc73cbb526a83de5e3d2b11c5e`.
  Both the root crate and isolated IME demo licence graphs passed.
* [Post-merge security scan 42856445237](https://github.com/Tigon32/miniquad/actions/runs/42856445237)
  succeeded on commit `37903df1286d8e09e99c2db3b34243765d54bbb4`.
* PR #61 replaced the demonstration-only `fontdue` graph with a locked
  isolated `skrifa` and `zeno` crate. PR #63
  [RustSec scan 42805287295](https://github.com/Tigon32/miniquad/actions/runs/42805287295)
  passed both resolved crate graphs with `--deny unmaintained`.
* PR #62 removed the unverified Android container. Android build/runtime
  remains **unqualified**, not a supported release target.
* The root is a library with a reviewed temporary-lockfile audit policy.
  The standalone IME demo keeps its committed Cargo lockfile. Resolved
  dependency versions can change across future audit dates; the workflow
  regenerates the root graph before scanning. A successful scan is a
  revision- and date-specific result, not an indefinite guarantee.
* Required PR CI uses `npm ci --ignore-scripts --no-audit --no-fund`;
  the scheduled security gate uses `npm audit --package-lock-only
  --audit-level=moderate` and denies unmaintained Rust crates.
* The checked-in HTML and JavaScript browser fixtures load the local
  `js/gl.js` and WASM artifacts over HTTP. No third-party script CDN
  is required. Fonts and external software outside those declared build
  inputs remain subject to individual source and licence review.
* The owner auto-merge job uses write permission and checks out trusted
  `master` only; ordinary test and scan jobs have `contents: read`.
  The trusted policy does not execute an untrusted PR head in a
  `pull_request_target` job.

These scan results are evidence of the enumerated checks, not a
penetration test or an audit of all code, all browser engines, or native targets.

## Verification addendum — 2026-11-11 (Playwright 1.65.0)

This section records a separate, later change. It does not alter the
2026-11-10 observations above.

* Source for the baseline finding: [issue #155](https://github.com/Tigon32/miniquad/issues/155),
  reviewed against `Tigon32/miniquad` public `master` at
  `1364b6db83c5409cd1190856fbd5b1c8d1c5e0f3`.
* Official release: [Playwright v1.65.0](https://github.com/microsoft/playwright/releases/tag/v1.65.0),
  published 2026-11-05 by `dgozman`, commit `a1f35e1955976e84411f9c10358228a80b763ebe`.
* `package.json` and `package-lock.json` now pin `@playwright/test` and
  the resolved `playwright`/`playwright-core` dependency to `1.65.0`
  (previously `1.56.1`).
* Browser revisions selected by the updated `playwright-core` package
  metadata (`node_modules/playwright-core/browsers.json`):
  Chromium (Chrome for Testing) `158.0.8127.18` (build `1254`,
  previously `141`/build `1194`), Firefox `159.0` (build `1572`,
  previously `142`/build `1495`), WebKit `27.2` (build `2388`,
  previously `26`/build `2215`).
* `npx playwright install chromium firefox webkit` downloaded these
  three new revisions to `~/Library/Caches/ms-playwright` on macOS
  arm64. The prior revisions remain cached under their own version
  directories; the cache key already includes the lockfile hash per
  [MADR 0007](adr/0007-use-supported-and-secure-toolchains.md).
* No compatibility break applicable to this project's config or tests
  was found in the 1.65.0 release notes. The notable items (Bun test
  runner, TypeScript `useDefineForClassFields`, inert-element action
  waits, RFC 6265 cookie matching, "no tests found" shard failure) do
  not apply: this project's suite is plain JavaScript (`.mjs`), runs
  under Node, and does not assert on cookie or inert-element behavior.
* Full local verification on macOS arm64, Node `v26.10.0`:
  `node --check js/gl.js` and `node --check` on each `js/*.mjs` passed;
  `npm run lint:js` (ESLint) passed with no findings; `node --test
  tests/*.test.cjs tests/*.test.mjs` reported **220 passed, 0 failed**;
  `cargo test --lib` reported **15 passed, 0 failed** (library crate,
  macOS arm64 host target); `cargo check --target
  wasm32-unknown-unknown --lib` and `cargo build --release --target
  wasm32-unknown-unknown` for the `quad` and `offscreen` examples, the
  `companions/draw` `showcase` example, the `companions/voxel`
  `offline` example, and the `experiments/drawing-comparison/external-consumer`
  `consume` example all built without error.
* `npx playwright test` (all three projects, `workers: 1`, the
  project's existing config) reported **168 passed, 0 failed** after
  generating the external-starter fixture locally with `node
  scripts/create-browser-project.mjs target/browser-starter --source
  path --miniquad-path "$(pwd)" --name miniquad-browser-starter` and
  `node target/browser-starter/scripts/build.mjs`, matching the step
  the CI workflows already run before this lane. That fixture step is
  a pre-existing environment requirement of `tests/browser/starter.spec.mjs`,
  unrelated to the Playwright version; it is not part of this change.
* This addendum updates only `@playwright/test`/`playwright-core` and
  the browser revisions they select. No other npm production or
  development dependency, CI workflow, Rust crate, or native binding
  changed in this update. Issue #155 also flagged `cargo-audit`
  0.22.2 → 0.23.0, CI runner image labels, `~/.cargo/config` vs
  `config.toml`, the unpinned `shell.nix` `<nixpkgs>` input, and the
  Apple default-graphics-backend and native-binding-crate items; those
  remain open, undecided, and out of scope for this Playwright-only
  change.
* [Issue #156](https://github.com/Tigon32/miniquad/issues/156) proposes
  a separate modern-platform-support and legacy-removal decision
  (draft MADR 0016). This Playwright update does not remove, weaken, or
  reinterpret any legacy browser or engine-capability test, and does
  not assert that all previously supported browsers remain supported;
  it only records the new Playwright-managed browser revisions above.
