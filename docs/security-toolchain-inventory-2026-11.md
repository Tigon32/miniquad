# Toolchain and dependency security inventory

* Review date: 2026-11-10
* Scope: Source on `master` before the security pinning PR
* Writing review: STE-aligned draft
* Review status: **Partial inventory, not a complete vulnerability audit**

## GitHub Actions

The following SHAs were resolved from the stated upstream GitHub tag references on 2026-11-10.
A SHA identifies the action code. It does not prove that code is free of security faults.

| Action | Source tag | Pinned commit |
| --- | --- | --- |
| `actions/checkout` | `v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/cache` | `v4` | `0057852bfaa89a56745cba8c7296529d2fc39830` |
| `actions/upload-artifact` | `v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

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

**A fresh npm advisory report has not yet been recorded.**
The committed lockfile fixes package resolution but does not prove that every package is secure.

## External assets and runner inputs

* `docs/terminology/miniquad.json` references the independent shared terminology registry at commit `0e755947aed328d5287e19e2f4adf0e46ae0549b`.
* The manual Android workflow uses `notfl3/cargo-apk` without a digest pin. Treat it as an unresolved supply-chain risk.
* GitHub-hosted runner images and `rustup stable` can change between runs.
* No external browser JavaScript CDN is required for the checked-in `js/gl.js` fixture.

## Required next checks

1. Run `npm audit --audit-level=high` against the lockfile. Review each finding.
2. Run a version-pinned RustSec advisory checker and record its database revision and affected target.
3. Review the Android image. Replace it with a digest-pinned image or a reviewed native build.
4. Check support and advisories for Node, ESLint, Playwright, Rust, and all third-party Actions.
5. Review `pull_request_target` token access and test that untrusted PR code cannot execute.
6. Record the security-check results in issue #16 before claiming full completion.

## References

* [MADR 0007](adr/0007-use-supported-and-secure-toolchains.md)
* [Security policy](../SECURITY.md)
* [Issue #16](https://github.com/Tigon32/miniquad/issues/16)
* [GitHub guidance for secure Actions](https://docs.github.com/en/actions/reference/security/secure-use)
