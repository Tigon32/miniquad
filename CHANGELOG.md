# Changelog

This file records each fork-scoped browser release candidate for issue #19.
A candidate section is not a release. See `docs/adr/0010-browser-release-candidates.md`
and `docs/release-candidate-contract.md` for the candidate process and its gate.

## 0.5.0-tigon32.1.rc.1 (candidate, not a release)

Tag: tigon32-miniquad-v0.5.0-tigon32.1.rc.1
Fork of: not-fl3/miniquad at 39c928fb7e09fd44e45f37fe9a98503968bca412 (package 0.4.11)
Package: miniquad 0.4.11 (version not changed)

### Breaking
- Browser bridge protocol: `js/gl.js` moves from `const version = 2;` (upstream) to
  `const version = 3;` in this fork. An upstream or hosted `gl.js` build does not
  work with this fork's WASM output, and this fork's `gl.js` does not work with
  an upstream WASM build. Pin `gl.js` and `app.wasm` together from the same
  candidate package.

### Added
- `scripts/release-candidate.mjs`: candidate label grammar, tag formatting,
  compatibility-core derivation, candidate package `prepare`/`verify`/`compare`,
  `collect-ci`, and `gate` commands per `docs/release-candidate-contract.md`.
- `scripts/release-browser.mjs`: the rollout/rollback `drill` command and the
  `measure` regression-guard command, including the ephemeral `127.0.0.1`
  release server used by both.
- `.github/workflows/release-candidate.yml`: the manual, candidate-scoped
  `Miniquad release candidate` reference workflow (`workflow_dispatch` only).
- `tests/release-candidate.test.mjs`: hermetic `node:test` unit coverage for
  the label grammar, manifest canonicalization, leak scan, statistics, and
  gate rules above.

### Fixed
- N/A (first candidate under this contract).

### Deprecated
- N/A.

### Upstream changes
- No Rust API changes relative to the `39c928f` merge base; `Cargo.toml`
  keeps `name = "miniquad"` and `version = "0.4.11"`.
- See `docs/upstream-attribution.md` for the original project, author, and
  licence notices this fork keeps.

### Known limits
- No merged, tagged candidate commit exists on `origin/master` yet, so the
  full candidate-vs-baseline reference drill and the 20-pair regression
  measurement have not run in `Miniquad release candidate` (manual CI) for
  this label. The bootstrap baseline `f837a98d415262320a8c66ef9f8024d8f2faeab1`
  remains `reference: "bootstrap-reference"`, not a qualified release.
- This candidate has not received owner approval. `review.ownerApproval` must
  stay `false`. A `.release` publication needs a separate, explicit owner
  decision; see `docs/release-candidate-contract.md` section 9.
