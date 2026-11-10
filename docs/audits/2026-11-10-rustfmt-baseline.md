# Repository-wide Rust formatting baseline

* Review date: 2026-11-10
* Starting revision: `078da9a3a2f12c4ab8de2e3a4190ca007e076d30`
* Status: **Observable, not yet compliant**
* Related issue: [#10](https://github.com/Tigon32/miniquad/issues/10)

## Purpose

The required CI checks formatting of the new Rust resource tests. A prior
repository-wide `cargo fmt --check` reported formatting differences in legacy
native and graphics modules. Passing the targeted check does not show that
all Rust source files comply.

## Procedure

The integration CI now runs a non-blocking diagnostic:

```sh
cargo fmt --all -- --check
```

The workflow reports the diagnostic outcome in the run log. Differences
remain visible even though they do not block an unrelated security or
browser PR. This is an observation step, not a green formatting gate.

## Promotion criteria

1. Review exact file differences, grouped by platform and ownership.
2. Format scoped files in reviewed PRs; do not silently rewrite native code.
3. Compare Rust compilation, tests and platform qualification as applicable.
4. Change the diagnostic into a blocking required gate only when it passes
   on the exact merged revision without exceptions.
5. Record CI run, source SHA, toolchain and any remaining platform limits.

No full-format claim or issue closure is made by this document.
