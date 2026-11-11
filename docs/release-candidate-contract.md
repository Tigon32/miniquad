# Browser release candidate contract

* Status: **Proposed** by [MADR 0010](adr/0010-browser-release-candidates.md). Not a release approval.
* Tracking: [#19](https://github.com/Tigon32/miniquad/issues/19)
* Design source: `f837a98d415262320a8c66ef9f8024d8f2faeab1` on `feat/release-candidate`
* Writing review state: **STE-aligned draft**

This document gives the rules, files, interfaces, and pass conditions for the first fork release candidate.
An implementer must use these rules exactly.
If a rule cannot be implemented, stop and record the blocker. Do not make the rule weaker.

## 1. Fixed facts

| Fact | Value | Source |
| --- | --- | --- |
| Upstream merge base | `39c928fb7e09fd44e45f37fe9a98503968bca412` | `git merge-base` with upstream `master` on 2026-11-11 |
| Upstream package version at the merge base | `0.4.11`, no upstream tag | `Cargo.toml` at the merge base |
| Upstream bridge protocol | `const version = 2;` | `js/gl.js` at the merge base |
| Fork bridge protocol | `const version = 3;` | `js/gl.js` at `f837a98` |
| Bootstrap reference | `f837a98d415262320a8c66ef9f8024d8f2faeab1` | Merge of PR #127. Local run: 141 Playwright tests passed in Chromium, Firefox, and desktop WebKit on macOS arm64 |
| Required status check on `master` | `rust-wasm` only; zero required approvals | Repository ruleset `protect_master` |
| Browser matrix trigger | `pull_request` on some paths, and `workflow_dispatch` | `.github/workflows/browser-acceptance-matrix.yml` |
| Local path leak | Current starter `app.wasm` contains `/Users/.../src/*.rs` strings | Observed with `strings` on a generated starter |

The required checks of the ruleset are not sufficient for a candidate.
Section 9 lists the checks that the candidate gate requires.

## 2. Version and tag rules

### 2.1 Grammar

```text
label     = core "-tigon32." fork-seq "." stage
core      = major "." minor "." patch          ; SemVer numeric identifiers, no leading zero
fork-seq  = positive integer, no leading zero
stage     = "rc." positive-integer | "release"
tag       = "tigon32-miniquad-v" label
```

Regular expression for a label:

```text
^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-tigon32\.([1-9]\d*)\.(?:rc\.([1-9]\d*)|release)$
```

The first candidate label is `0.5.0-tigon32.1.rc.1`.
Its tag is `tigon32-miniquad-v0.5.0-tigon32.1.rc.1`.

### 2.2 Precedence

Use SemVer 2.0.0 precedence. Do not write a different order.
With this grammar, `X.Y.Z-tigon32.F.rc.R` sorts before `X.Y.Z-tigon32.F.release`, because `rc` sorts before `release` in ASCII order.
`F` and `R` compare as numbers.

### 2.3 Compatibility core

Input: the previous core and three Boolean review results.

| Review result | Meaning |
| --- | --- |
| `rustApiBreaking` | A public item in the Rust compatibility surface was removed, or its signature or required behavior changed incompatibly |
| `browserProtocolBreaking` | A bridge that is valid for the previous core cannot start the new WASM file, or the reverse; or a documented `importObject` or export contract changed incompatibly |
| `changed` | Any other shipped behavior or artifact changed |

Rule while `major` is `0`:

* If `rustApiBreaking` or `browserProtocolBreaking`, the result is `0.(minor+1).0`.
* Else if `changed`, the result is `0.minor.(patch+1)`.
* Else the result is the previous core.

Rule when `major` is `1` or more: a breaking result increases `major`. Otherwise use the same patch rule.

For `0.5.0-tigon32.1.rc.1`, the previous core is the upstream `0.4.11`.
`browserProtocolBreaking` is `true`: the bridge protocol changed from version 2 to version 3.
`rustApiBreaking` is `false` from the observed source diff. The candidate reviewer must confirm it.
The core `0.5.0` is a **proposed** breaking-ABI decision. It does not change the crate name or `Cargo.toml`.
The candidate can use it. A `.release` publication needs owner approval of it (section 15).

A later candidate with the same core increases `R`.
A later candidate with a different core starts at `F+1` and `rc.1`.

### 2.4 Package version

`Cargo.toml` stays `name = "miniquad"` and `version = "0.4.11"`.
The candidate record states `cargoPackageVersion: "0.4.11"` and `compatibilityCore: "0.5.0"`.
The tool must fail if `Cargo.toml` at the candidate commit has a different name or version, unless a merged decision changes this contract.

### 2.5 Tag creation

1. Create the tag only after the candidate commit is merged into `master` through a reviewed PR.
2. Use an annotated tag. Message: `Fork release candidate <label> of Tigon32/miniquad. Not an upstream Miniquad release. Not a release approval.`
3. Do not move, replace, or delete a tag. A failed candidate keeps its tag and gets a `FAILED` record. The next candidate uses the next `rc` number.
4. Do not create a GitHub Release object for a candidate.
5. Do not create a `.release` tag. That needs a separate owner approval.

### 2.6 Other contracts

Record these versions separately. Do not join them to the core:

| Contract | Version source |
| --- | --- |
| Core JS/WASM ABI | `const version` in `js/gl.js`; must be `3` |
| Starter parameter surface | `mq_params_version()`; must be `1` |
| `miniquad-draw`, `miniquad-voxel` | `version` in `companions/*/Cargo.toml` |
| `js/miniquad.mjs`, `js/runtime.mjs`, `js/runtime.html`, `js/host-preferences.mjs` | No version field. Record `null` and bind them to the asset source SHA |

### 2.7 Upstream synchronization and deprecation

* For each candidate, record the merge base with upstream `master`, its upstream `Cargo.toml` version, and each upstream change imported since the previous candidate.
* Import upstream changes only through an integration PR with its own tests.
* Mark a compatibility commitment as deprecated in the change log at least one fork sequence `F` before its removal.
  The removal is a breaking change under section 2.3.

## 3. Files and interfaces for the implementer

The implementer adds only these files. The parent integrates the listed edits to existing documents.

| File | Action | Owner |
| --- | --- | --- |
| `scripts/release-candidate.mjs` | New. Commands `label`, `prepare`, `verify`, `compare`, `collect-ci`, `gate`, and exported pure functions | Implementer |
| `scripts/release-browser.mjs` | New. Commands `drill` and `measure`, and exported pure functions | Implementer |
| `tests/release-candidate.test.mjs` | New. `node:test` unit tests without network or browser | Implementer |
| `.github/workflows/release-candidate.yml` | New. Manual reference-profile job (section 8) | Implementer |
| `CHANGELOG.md` | New. Section 10 | Implementer |
| `docs/release-evidence/<label>.md` and `docs/release-evidence/<label>/*.json` | New after the runs. Section 11 | Evidence writer |
| `docs/adr/README.md`, `docs/glossary.md`, `docs/release.md`, `docs/release-evidence/TEMPLATE.md`, `docs/browser-performance-sli-policy.md` | Links and terms only | Parent |

Do not change `Cargo.toml`, `src/`, `js/`, `templates/`, `scripts/create-browser-project.mjs`, `package.json`, `package-lock.json`, or existing workflows.
Do not add a dependency. Use Node.js built-in modules, Git, Cargo, `tar`, the `gh` CLI, `@playwright/test` `1.56.1`, and `pngjs` `7.0.0`.
Import browsers with `import { chromium, firefox, webkit } from "@playwright/test"`.
Reuse `compressionReport` and `percentile` from `scripts/profile-browser.mjs` if the import has no side effect.

### 3.1 Exported pure functions

`scripts/release-candidate.mjs`:

| Function | Contract |
| --- | --- |
| `parseLabel(label)` | Returns `{core:{major,minor,patch}, forkSeq, stage:"rc"\|"release", rc:number\|null}`. Throws on any other text |
| `formatTag(label)`, `parseTag(tag)` | Add or remove the prefix `tigon32-miniquad-v`. `parseTag` validates the label |
| `compareLabels(a, b)` | SemVer 2.0.0 precedence. Returns `-1`, `0`, or `1` |
| `deriveCore(previousCore, {rustApiBreaking, browserProtocolBreaking, changed})` | Section 2.3 |
| `isSafePayloadName(name)` | `true` only for `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` without `..` |
| `canonicalizeManifest(raw, payloadFiles, expected)` | Section 5.3. Returns `{canonical, timing}`. Throws a typed error |
| `scanForLeaks(bytes, forbiddenStrings)` | Section 5.4. Returns a list of findings with file offset and rule ID, without the matched secret text |
| `evaluateGate(record)` | Section 9. Returns `{result, reasons}` |

`scripts/release-browser.mjs`:

| Function | Contract |
| --- | --- |
| `median(values)` | Mean of the two middle values when the count is even |
| `nearestRank(sorted, p)` | Value at 1-based rank `ceil(p * n)` |
| `medianConfidenceRanks(n, alpha = 0.05)` | Largest `k` with `P(Binomial(n, 0.5) <= k - 1) <= alpha / 2`. Returns `{low: k, high: n - k + 1, coverage}`. For `n = 20`: `{low: 6, high: 15}`, coverage about 0.9586 |
| `clockResolution(samples)` | Input: arrays of consecutive `performance.now()` readings from section 7.3. Returns the smallest positive difference between consecutive readings, or `null` if no positive difference exists. Never returns `0` |
| `evaluateMetric({baseline, candidate, resolution})` | Section 7.5. `resolution` is a positive number or `null` |
| `createReleaseServer({packages})` | Section 6.1. Returns `{url, deploy(name), close()}` |

## 4. Paths and safety rules

* The operator supplies `--repo` and `--out` as absolute paths.
* `--out` must not exist. The tool creates it. The tool fails if `--out` is inside a Git working tree or inside a system temporary directory.
* The tool writes each file with the `wx` flag. It never overwrites.
* The tool never deletes a file or a directory. The operator removes old work directories manually.
* The tool never writes the absolute paths `--repo`, `--out`, the home directory, or `CARGO_HOME` into a payload file.
  Console output can show them.
* The tool never reads or writes a token. `collect-ci` uses the `gh` CLI and records only public run data.
* The Git dependency URL is `https://github.com/Tigon32/miniquad.git`. The tool rejects any other URL and any URL that contains `@`.

## 5. Candidate package

### 5.1 `prepare` command

```sh
node scripts/release-candidate.mjs prepare \
  --sha <40-hex> --role <baseline|candidate> \
  [--label <label>] [--reference <bootstrap-reference|qualified-release>] \
  --repo <absolute clone path> --out <absolute new directory> [--lockfile <absolute Cargo.lock>]
```

Role rules:

| Role | `--label` | `--reference` |
| --- | --- | --- |
| `candidate` | Required. A valid `rc` label | Not permitted |
| `baseline` with `bootstrap-reference` | Not permitted | Required |
| `baseline` with `qualified-release` | Required. The label of that earlier `.release`. Its tag must point to `--sha` | Required |

A baseline package never receives the candidate label.
For the first candidate, the baseline package has `label: null` and `reference: "bootstrap-reference"`.
It does not state that `f837a98` has a `0.5.0` label or a tag.

Steps, in this order. Stop at the first failure.

1. Validate `--sha` as 40 lowercase hexadecimal characters. Validate `--role`, `--label`, and `--reference` with the role rules.
2. Require `git -C <repo> cat-file -e <sha>^{commit}`.
3. Require `git -C <repo> merge-base --is-ancestor <sha> refs/remotes/origin/master`. Record the SHA of `refs/remotes/origin/master`. The operator runs `git fetch origin master` before this step.
4. Require that `Cargo.toml` at `<sha>` has `name = "miniquad"` and `version = "0.4.11"`. Require that `js/gl.js` at `<sha>` contains `const version = 3;`.
5. Create `<out>/source`. Run `git -C <repo> archive --format=tar <sha>` and pipe it to `tar -x -f - -C <out>/source`.
6. Run the generator of the selected commit:

   ```sh
   node <out>/source/scripts/create-browser-project.mjs <out>/consumer \
     --source git --git-url https://github.com/Tigon32/miniquad.git \
     --rev <sha> --git-repo <repo> --name release-fixture --title "Miniquad release fixture"
   ```

7. If `--lockfile` is present, copy it to `<out>/consumer/Cargo.lock` and run `cargo fetch --locked` in `<out>/consumer`.
8. Run `node <out>/consumer/scripts/build.mjs --release` in `<out>/consumer` with the environment of section 5.2.
9. If `--lockfile` is present, require that `Cargo.lock` has the same SHA-256 after the build.
10. Canonicalize the manifest (section 5.3). Run the leak scan (section 5.4).
11. Copy the payload to `<out>/package/payload/`. Write the package files (section 5.5).
12. Run `verify` on `<out>/package`. Fail if `verify` fails.

### 5.2 Build environment

Set `CARGO_ENCODED_RUSTFLAGS` to these arguments, separated by the byte `0x1f`:

```text
--remap-path-prefix=<CARGO_HOME>=/cargo-home
--remap-path-prefix=<out>/consumer=/consumer
--remap-path-prefix=<home directory>=/home-redacted
```

`CARGO_HOME` is the value of the environment variable, or `<home>/.cargo`.
If `RUSTFLAGS` or `CARGO_ENCODED_RUSTFLAGS` is already set, fail. Do not combine flags.
Record the remap targets, not the source paths.
Use the same rules for the baseline and the candidate.

### 5.3 Canonical payload manifest

The generated `web/MANIFEST.json` has `generatedAt`, `updatedAt`, `source`, and `files`.

Rules for `canonicalizeManifest`:

1. `source.mode` is `"git"`, `source.sha` equals `--sha`, and `source.dirty` is `false`.
2. Each `files[].file` passes `isSafePayloadName`. No name occurs twice.
3. The set of `files[].file` plus `MANIFEST.json` equals the set of regular files in `web/`. A directory, a symbolic link, or an extra file fails.
4. The set of `files[].file` is exactly `app.wasm`, `gl.js`, `host-preferences.mjs`, `index.html`, `miniquad.mjs`, `runtime.html`, and `runtime.mjs`.
5. Each `sha256` and `bytes` value equals the file bytes.
6. `gl.js` bytes equal `git show <sha>:js/gl.js`. Each other copied asset equals its `sourcePath` at `<sha>`.
7. `sourcePath`, if present, is a relative path without `..` and without a leading `/`.
8. Any other top-level key, except `generatedAt` and `updatedAt`, fails.

Canonical form, sorted by `file`, written as `JSON.stringify(value, null, 2)` plus one newline:

```json
{
  "schema": "miniquad-release-payload/1",
  "label": "0.5.0-tigon32.1.rc.1",
  "role": "candidate",
  "reference": null,
  "source": {"repository": "https://github.com/Tigon32/miniquad", "sha": "<40-hex>"},
  "abiVersion": 3,
  "files": [{"file": "app.wasm", "sha256": "<hex>", "bytes": 0, "sourcePath": null}]
}
```

`generatedAt` and `updatedAt` go only to `receipts/build-timing.json`.
The canonical manifest replaces `MANIFEST.json` in `payload/`.
For a bootstrap baseline, `label` is `null` and `reference` is `"bootstrap-reference"`.
For a candidate, `reference` is `null`.

### 5.4 Leak scan

Scan every payload file as bytes, and every committed evidence JSON file.
Fail on any finding.

| Rule ID | Match |
| --- | --- |
| `local-path` | One of the absolute paths `--repo`, `--out`, home directory, and `CARGO_HOME`, followed by `/` or `\\`. Do not scan for a path that is `/` or shorter than 4 characters |
| `unix-home` | `/Users/<name>/`, `/home/<name>/`, or `/root/`, where `<name>` is one or more characters other than `/` |
| `windows-home` | `<drive>:\Users\` with either slash direction |
| `file-url` | `file:` followed by `//` |
| `credential-url` | `http` or `https` URL with user information before `@` |
| `token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, or `github_pat_` followed by 20 or more word characters |

A finding records the file, the rule ID, and the byte offset. It does not record the matched text.
Do not scan for a user name as a bare word. Words such as `root` in `:root` or `runner` can be valid content.
Scan only for full path prefixes, standard user directory patterns, URLs, and token patterns.

### 5.5 Package layout

```text
<out>/package/
  payload/                 deployable files: the 7 assets and the canonical MANIFEST.json
  provenance.json          not deployed
  sizes.json               not deployed
  Cargo.lock               not deployed; copied from <out>/consumer
  receipts/build-timing.json
```

`provenance.json` (`schema: "miniquad-release-provenance/1"`):

| Field | Value |
| --- | --- |
| `label`, `role`, `reference` | From the command; `label` is `null` for a bootstrap baseline |
| `assetSource.sha` | `--sha` |
| `assetSource.originMasterSha` | SHA of `refs/remotes/origin/master` at step 3 |
| `assetSource.generatorSha256` | SHA-256 of `scripts/create-browser-project.mjs` at `--sha` |
| `assetSource.templatesTree` | `git rev-parse <sha>:templates/browser` |
| `tool.sha`, `tool.dirty` | `HEAD` and dirty state of the repository that contains the running `release-candidate.mjs` |
| `tool.scriptSha256` | SHA-256 of the running `release-candidate.mjs` |
| `inputs` | SHA-256 of consumer `Cargo.toml`, `Cargo.lock`, `scripts/build.mjs`, and tool `package-lock.json` |
| `toolchain` | First line or full output of `rustc -vV`, `cargo -V`, `rustup show active-toolchain`, `node -v`, `npm -v`, `git --version`, `tar --version`; `process.versions.zlib` and `process.versions.brotli` |
| `host` | `os.type()`, `os.release()`, `os.arch()`, CPU model, logical CPU count, total memory |
| `build.remapTargets` | `["/cargo-home", "/consumer", "/home-redacted"]` |
| `upstream` | `{mergeBaseSha, cargoVersion}` when an upstream ref is available, else `null` with a reason |
| `canonicalManifestSha256` | SHA-256 of `payload/MANIFEST.json` |

`sizes.json` (`schema: "miniquad-release-sizes/1"`): for each payload file, `sha256`, `rawBytes`, `gzipBytes` (level 9), and `brotliBytes` (quality 11), and totals.
Also give the `app.wasm` plus `gl.js` totals.
These are computed file sizes, not network transfer measurements.

### 5.6 `verify` and `compare`

`verify --package <dir>` repeats rules 2 to 5 and 7 of section 5.3 against `payload/`, runs the leak scan, compiles `app.wasm` with `new WebAssembly.Module`, and requires exports `memory`, `main`, `frame`, `crate_version`, `allocate_transfer_vec_u8`, `discard_transfer_vec_u8`, and `mq_params_version`.

`compare --a <package> --b <package>` passes only when both canonical manifests are byte-identical and every payload file is byte-identical.

**Reproducibility rule:** prepare the candidate twice, in two different new `--out` directories, on one host and toolchain. Use `--lockfile` from the first package for the second. `compare` must pass.
This proves repeatability for that host and toolchain only.

## 6. Rollout and rollback exercise

### 6.1 Server

`createReleaseServer` listens on `127.0.0.1` with port `0`.
It serves only files that the active canonical manifest lists, plus `MANIFEST.json`.

* Path `/app/` and `/app/<file>` map to the active package. `/app/` serves `index.html`.
* `/measure/baseline/` and `/measure/candidate/` map to fixed packages for section 7.
* Each response has `Cache-Control: no-cache`, `ETag: "sha256-<hex>"`, `X-Content-Type-Options: nosniff`, and a content type from the generated `serve.mjs` table.
* A matching `If-None-Match` gives `304`.
* An unknown path, an encoded slash, or `..` gives `404`. Other methods than `GET` and `HEAD` give `405`.
* `deploy(name)` changes the active package in memory. It does not copy or delete files.
* `close()` stops the server. The command closes the server on success and on failure.

### 6.2 `drill` command

```sh
node scripts/release-browser.mjs drill --baseline <package> --candidate <package> \
  --out <absolute new directory> --engines chromium,firefox,webkit --headful <none|firefox,webkit>
```

For each engine, use one browser process and these phases:

| Phase | Action |
| --- | --- |
| `baseline` | `deploy("baseline")`, then the phase check in a new context |
| `candidate` | `deploy("candidate")`, then the phase check in a new context. Keep this page open |
| `rollback-fresh` | `deploy("baseline")`, then the phase check in a new context |
| `rollback-reload` | Reload the open candidate page. The phase check expects baseline hashes |

Page settings: viewport 800 x 500, `deviceScaleFactor` 1, `colorScheme: "dark"`, `reducedMotion: "no-preference"`, `contrast: "no-preference"`, `forcedColors: "none"`.
Chromium uses the launch arguments of `playwright.config.mjs`.

Phase check. All conditions must pass:

1. Node `fetch` of every manifest file gives the SHA-256 of the expected package.
2. The browser receives `index.html`, `gl.js`, `miniquad.mjs`, `runtime.html`, `runtime.mjs`, `host-preferences.mjs`, and `app.wasm`. The SHA-256 of each response body equals the expected package. A `304` response is not valid in `rollback-reload`, because the ETag changed.
3. `#status` has `data-state="running"` within 30 seconds.
4. In the runtime frame, `miniquadRuntime.exports.crate_version()` is `3`, `mq_params_version()` is `1`, and `miniquadRuntime.frames` reaches at least 3.
5. Canvas screenshot: the pixel at (10, 10) is exactly `[16, 16, 26]`, and the center pixel is different.
6. Set `#background` to `#112233` and dispatch `input`. After 100 ms, the pixel at (10, 10) is exactly `[17, 34, 51]`.
7. No `pageerror`, no console message of type `error`, and no failed request.

Keep a full-page PNG and a canvas PNG for each engine and phase, and all error text.
Write `drill.json` (`schema: "miniquad-release-drill/1"`) with the browser versions, the user agents, the phase results, the observed hashes, and the SHA-256 of each PNG.
The result is `PASS` only if all phases pass in all requested engines. Otherwise it is `FAIL`.

## 7. Regression guard

### 7.1 Reference profile

Profile ID: `gha-ubuntu-24.04-x64-pw1.56.1`.

* One GitHub-hosted `ubuntu-24.04` job from section 8. No other command runs in the job during measurement.
* Browsers from `npx playwright install --with-deps chromium firefox webkit` with Playwright `1.56.1`.
* Chromium headless with SwiftShader arguments. Firefox and WebKit headful under `xvfb-run -a`, as in the existing browser matrix.
* Fixture: the generated consumer from section 5, built from each package. The same fixture name and build rules apply to both.
* Network: the local server of section 6.1. No network shaping.

A run on another host has a different profile ID. Such a run can be a rehearsal only.
The gate does not accept it for the regression guard.

### 7.2 Cold and warm

* **Cold:** a new browser context with an empty cache, in the running browser process. It is not a new browser process or an operating system cold start.
* **Warm:** `page.reload()` in the same context after the cold sample. All payload responses must be `304`. If one response is `200`, the sample is invalid.

### 7.3 Metrics

An init script records times in the top document with `performance.now()`. Time zero is the navigation start of the top document.

| Metric | Definition | Gated |
| --- | --- | --- |
| `coldStartupToRunningMs` | First `MutationObserver` callback where `#status` has `data-state="running"` | Yes |
| `coldStartupToFirstFrameMs` | First top-document `requestAnimationFrame` callback where `miniquadRuntime.frames >= 1` in the runtime frame. The resolution is one top-document frame | Yes |
| `warmStartupToRunningMs` | As cold, for the warm reload | Yes |
| `warmFrameIntervalP95Ms` | After the warm run reaches `frames >= 3`, record 121 `requestAnimationFrame` times in the runtime frame. Use nearest-rank p95 of the 120 intervals | Yes |
| `warmFrameIntervalP50Ms` | As above, p50 | No, report only |
| `wasmMemoryBytes` | `miniquadRuntime.exports.memory.buffer.byteLength` after the frame interval samples | No, report only |
| `webglRenderer` | `UNMASKED_RENDERER_WEBGL` when available, else `null` | No, report only |
| `clockSamples` | After each warm sample, in the top document and in the runtime frame: call `performance.now()` in a loop for 50 ms and keep each reading that differs from the previous reading, up to 2000 readings | Input to the timer floor in section 7.5 |
| GPU memory, JavaScript heap, input latency, first visible pixel, network latency | `null` with reason `not measured: no portable API in this profile` | No |

### 7.4 `measure` command and pairing

```sh
node scripts/release-browser.mjs measure --baseline <package> --candidate <package> \
  --out <absolute new directory> --engines chromium,firefox,webkit --pairs 20 \
  --profile <profile ID> --headful <none|firefox,webkit>
```

* `--pairs` must be 20 or more.
* For each engine, run pairs `i = 0 .. pairs - 1`. For even `i`, run baseline then candidate. For odd `i`, run candidate then baseline.
* Each run is one cold sample and one warm sample in one new context.
* Record `os.loadavg()` before and after each run. Do not use it to drop samples.
* A navigation timeout of 30 seconds, an error from section 6.2 item 7, or a warm `200` response makes the sample invalid.
  Any invalid sample makes the metric result `INCONCLUSIVE`. Do not repeat or replace a sample.
* All samples go to `samples.json`. The tool never drops a sample. It never invents a value.
* If the browser version or user agent differs between baseline and candidate runs, the engine result is `INCONCLUSIVE`.

### 7.5 Rule for each gated metric and engine

Let `B` be the baseline samples and `C` be the candidate samples.

1. If `B` or `C` has fewer than 20 valid values, the result is `INCONCLUSIVE`.
2. `resolution` is the largest `clockResolution` value of all baseline and candidate runs of this engine in this session.
   If any run gives `null`, the result is `INCONCLUSIVE`. Do not use `0`, a constant, or the sample spread instead.
3. `limit = nearestRank(sorted(B), 0.90) + resolution`.
4. `{low, high} = medianConfidenceRanks(|C|)`. `ciLow = sorted(C)[low - 1]`, `ciHigh = sorted(C)[high - 1]`.
5. If `ciHigh <= limit`, the result is `PASS`.
6. Else if `ciLow > limit`, the result is `FAIL`.
7. Else the result is `INCONCLUSIVE`. This includes a median at or below `limit` with `ciHigh` above `limit`.

The `resolution` term covers the quantization of the measured clock.
It does not cover the one-frame poll quantization of `coldStartupToFirstFrameMs`. That quantization applies to both arms in the same way.
Also report `median(B)`, `median(C) - median(B)`, and the percent change. They do not change the result.

The session result is `PASS` only if all gated metrics in all engines pass.
It is `FAIL` if one metric fails. Otherwise it is `INCONCLUSIVE`.
A new session is a new workflow run. Keep all runs. Do not exceed three reference runs for one candidate label.
The regression result is `PASS` only if the newest run is `PASS` and no run is `FAIL`.
If any retained run for the candidate has `FAIL`, the gate result is `FAILED`.
After three runs without `PASS`, make a new candidate label.

**Meaning:** the guard detects a candidate whose typical value is above the upper baseline range in the same job.
It is a relative regression limit for one reference profile.
It is not an absolute objective. It does not describe user devices or mobile browsers.

### 7.6 Size

Size is deterministic. It has no statistical rule.
Report per-file and total deltas of raw, gzip, and Brotli bytes.
If the candidate Brotli total of all payload files is larger than the baseline total, the gate needs `review.sizeIncreaseAccepted: true` and a reason.
The 500 KiB value stays a hypothesis. It is not a gate.

## 8. Manual workflow

File: `.github/workflows/release-candidate.yml`. Name: `Miniquad release candidate`. Job ID: `reference`.

* Trigger: `workflow_dispatch` only. Inputs: `candidate_sha`, `baseline_sha`, `label`, `rollback_target` (`bootstrap-reference` or `qualified-release`), `pairs` (default `20`).
* `permissions: contents: read`. No secret. `concurrency: release-candidate`, no cancel. `timeout-minutes: 150`.
* Use the pinned action SHAs that the existing workflows use. `node scripts/check-actions.mjs` must pass.
* Pass inputs through `env:`. Do not put `${{ inputs.* }}` inside a `run:` script.
* Checkout with `fetch-depth: 0`. Require `github.sha == candidate_sha`. Require both SHAs to be ancestors of `origin/master`.
* Steps: install stable Rust and `wasm32-unknown-unknown`; `npm ci --ignore-scripts --no-audit --no-fund`; install Playwright browsers; `prepare` baseline; `prepare` candidate; second `prepare` of the candidate with the first `Cargo.lock`; `compare`; `xvfb-run -a node scripts/release-browser.mjs drill ... --headful firefox,webkit`; `xvfb-run -a node scripts/release-browser.mjs measure ... --profile gha-ubuntu-24.04-x64-pw1.56.1 --headful firefox,webkit`.
* Use directories under `$RUNNER_TEMP/release-candidate/`.
* Upload one artifact `release-candidate-<label>` with packages (without `consumer/target`), `drill.json`, PNG files, `samples.json`, and `regression.json`. Retention: 30 days. Upload also when a step fails.
* The job fails if `compare` fails, `drill` is not `PASS`, or `measure` is not `PASS`.

Run this workflow only for a candidate. Do not run it for each pull request.

## 9. Candidate gate

### 9.1 `collect-ci`

```sh
node scripts/release-candidate.mjs collect-ci --sha <candidate sha> --out <absolute new file>
```

Use `gh api repos/Tigon32/miniquad/actions/runs?head_sha=<sha>&per_page=100` and the jobs API.
For each required job, select the newest completed run with `head_sha` equal to the candidate SHA. Record the run ID, the job ID, the conclusion, and the URL.

| Workflow name | Job | Required conclusion |
| --- | --- | --- |
| `Miniquad integration CI` | `rust-wasm` | `success` |
| `Miniquad three-engine browser acceptance` | `engines` | `success` |
| `Security advisory review` | All jobs | `success` |
| `Miniquad release candidate` | `reference` | `success` |

These workflows run on the merge commit only by `workflow_dispatch` on `master`.
Dispatch them when `master` points to the candidate SHA. A run for a PR head SHA is not evidence for the merge commit.
A skipped, cancelled, pending, or absent job is not a pass.

### 9.2 Gate record

`docs/release-evidence/<label>/gate.json`, `schema: "miniquad-release-gate/1"`:

| Field | Required content |
| --- | --- |
| `label`, `tag` | Valid; the tag is annotated and points to `candidateSha` |
| `candidateSha`, `toolSha` | 40 hexadecimal characters; `candidateSha` is an ancestor of `origin/master`; the candidate came from a merged PR |
| `baseline` | `{sha, kind, tag}`. `kind` is `bootstrap-reference` or `qualified-release` |
| `upstream` | `{mergeBaseSha, cargoVersion, importedChanges}` |
| `compatibility` | `{previousCore, rustApiBreaking, browserProtocolBreaking, changed, evidence, derivedCore}`. `derivedCore` equals `deriveCore(...)` and the label core |
| `cargoPackage` | `{name: "miniquad", version: "0.4.11"}` |
| `contracts` | Section 2.6 values |
| `packages` | Canonical manifest SHA-256 for baseline and candidate; `reproducible: true` from `compare` |
| `ci` | Output of `collect-ci` |
| `drill` | `{reference, local}`. Each has the result, the profile, and the SHA-256 of `drill.json` |
| `regression` | `{profileId, runs: [{runId, result}], result, metrics}`. The profile is `gha-ubuntu-24.04-x64-pw1.56.1`. All runs for the label are listed |
| `sizes` | Totals and deltas from section 7.6 |
| `security` | Workflow run, open applicable findings, and approved risk decisions |
| `changelog` | `CHANGELOG.md` at `candidateSha` has the heading `## <label>` |
| `native` | Windows, Linux, macOS, Android, iOS, and other native targets: each `unqualified`, or a link to a separate evidence record |
| `limits` | Section 12 limits, at least |
| `review` | `{reviewerKind, reviewer, method, reference, date, sizeIncreaseAccepted, sizeIncreaseReason, waivers, ownerApproval}`. Section 9.4 |

### 9.3 `evaluateGate` rules

Evaluate all rules. Return all reasons.

* `FAILED` if any of these is true: the drill result is `FAIL`; a retained regression run is `FAIL`; a required CI job has conclusion `failure`; `compare` failed; a payload leak finding exists.
* Else `BLOCKED` if any of these is true: a field is missing or invalid; a CI job is absent or not `success`; the drill result is missing for the reference profile or the local exercise; the regression result is not `PASS`; the profile ID is different; `compatibility.derivedCore` differs from the label core; `cargoPackage` differs; the change log heading is missing; a native target is not `unqualified` and has no evidence link; `review.reviewerKind`, `review.reviewer`, `review.method`, or `review.reference` is empty or invalid; `review.ownerApproval` is not `false`; the size increased without acceptance; a waiver exists; `baseline.kind` is `bootstrap-reference` while a `tigon32-miniquad-v*.release` tag exists; `baseline.kind` is `qualified-release` and the baseline tag does not point to `baseline.sha`.
* Else `QUALIFIED-CANDIDATE`.

`QUALIFIED-CANDIDATE` means that this candidate passed the listed checks in the listed profile and engines.
It does not mean released, stable, or approved for publication.
A waiver is recorded with check, scope, risk, owner, and expiry. A waiver keeps the result `BLOCKED`.
### 9.4 Candidate review and owner approval

The candidate review and the owner approval are different records.

| Field | Rule |
| --- | --- |
| `reviewerKind` | `person` or `automated` |
| `reviewer` | For `person`, the GitHub login. For `automated`, the agent or tool name and model, for example `GitHub Copilot (automated agent)`. Never write a person's login for an automated review |
| `method` | For `automated`, the exact commands, the tool SHA, and the input files that the review checked. For `person`, a short statement of what the person checked |
| `reference` | URL of the PR comment or review that contains the decision |
| `ownerApproval` | Must be `false` in a candidate gate record |

An automated reviewer can give `QUALIFIED-CANDIDATE` when all technical, security, CI, browser, rollback, and regression rules pass.
An automated review must not say that the owner approved, reviewed, or released the candidate.
A candidate result or a rehearsal is never a release approval.

A `.release` tag or any stable publication needs a separate record with explicit approval by the human owner `Tigon32`.
That record links a comment or review by `Tigon32` that names the label and the candidate SHA.
This contract does not define that record. A later decision must define it.

## 10. Change log

`CHANGELOG.md` at the repository root. Each candidate has one section:

```text
## 0.5.0-tigon32.1.rc.1 (candidate, not a release)

Tag: tigon32-miniquad-v0.5.0-tigon32.1.rc.1
Fork of: not-fl3/miniquad at 39c928fb7e09fd44e45f37fe9a98503968bca412 (package 0.4.11)
Package: miniquad 0.4.11 (version not changed)

### Breaking
### Added
### Fixed
### Deprecated
### Upstream changes
### Known limits
```

The first section must state the bridge protocol change from version 2 to version 3.
It must state that an upstream or hosted `gl.js` does not work with this WASM.
It must keep the upstream credit and link `docs/upstream-attribution.md`.

## 11. Evidence and retention

* Commit `docs/release-evidence/<label>.md` from the template, and these JSON files: `gate.json`, `sizes.json`, `drill-reference.json`, `drill-local.json`, `regression.json`, `provenance-baseline.json`, `provenance-candidate.json`.
* Do not commit PNG files, `samples.json`, packages, or `Cargo.lock`. Record their SHA-256 values and the workflow artifact URL.
  Keep the local exercise files outside the repository. Record their SHA-256 values.
* Run the leak scan on each committed JSON file before the commit.
* The workflow artifact expires. The SHA-256 values and the run URL stay as the permanent record.

## 12. Operator sequence for `0.5.0-tigon32.1.rc.1`

1. The implementer opens a PR with the section 3 files. Required local checks: `node --test tests/release-candidate.test.mjs`, `node --check` on both scripts, `node scripts/check-actions.mjs`, `node scripts/check-docs.mjs`.
2. Review and merge the PR under the `protect_master` rules. The merge commit is `S`.
3. On `master` at `S`, dispatch `Miniquad integration CI`, `Miniquad three-engine browser acceptance`, and `Security advisory review`. Wait for `success`.
4. Create and push the annotated tag `tigon32-miniquad-v0.5.0-tigon32.1.rc.1` at `S`.
5. Dispatch `Miniquad release candidate` on `master` at `S` with `baseline_sha` `f837a98d415262320a8c66ef9f8024d8f2faeab1` and `rollback_target` `bootstrap-reference`.
6. On the macOS computer, run `prepare` for the baseline with `--role baseline --reference bootstrap-reference` and for the candidate with `--role candidate --label 0.5.0-tigon32.1.rc.1`, in a new directory outside the repository and outside system temporary directories. Run the second `prepare` and `compare`. Run `drill` with all three engines. Optional: run `measure` with profile `local-macos-shared-rehearsal`. Its result is a rehearsal and does not enter `regression`.
7. Run `collect-ci`. Write `gate.json`. Run `node scripts/release-candidate.mjs gate --record <gate.json>`.
8. Open the evidence PR. The candidate reviewer (section 9.4) records the decision. Merge. Post the result to issue #19 with the exact SHAs and limits. State that the result is not a release approval.

If `master` moves before step 5, the reference job cannot have `github.sha == S`. Then make a new candidate from the new `master`.

## 13. Required unit tests

`tests/release-candidate.test.mjs` must test these cases. Each case must fail without the related rule.

* Label: accept `0.5.0-tigon32.1.rc.1`; reject `0.5.0`, `v0.5.0-tigon32.1.rc.1`, `0.5.0-tigon32.01.rc.1`, `0.5.0-tigon32.1.rc.0`, `0.5.0-tigon32.1.final`, and `0.4.11+tigon32.1`.
* Precedence: `rc.1 < rc.2 < rc.10 < release` for the same `F`; `F=1 release < F=2 rc.1`.
* Core: `0.4.11` plus browser break gives `0.5.0`; plus change only gives `0.4.12`; `1.2.3` plus break gives `2.0.0`.
* Manifest: reject `../x`, `a/b`, `.hidden`, a duplicate name, an extra file, a missing file, a hash mismatch, `dirty: true`, a different SHA, and an unknown top-level key. Accept a valid manifest and remove both timestamps.
* Leak scan: find each rule ID in a synthetic buffer; the finding does not contain the matched text; `:root {` and the word `runner` give no finding.
* Statistics: `medianConfidenceRanks(20)` gives 6 and 15; `nearestRank` of 1 to 20 at 0.90 gives 18; `evaluateMetric` gives `PASS`, `FAIL`, and `INCONCLUSIVE` on fixed data; a median at or below the limit with `ciHigh` above the limit gives `INCONCLUSIVE`; fewer than 20 values give `INCONCLUSIVE`; a `null` clock resolution gives `INCONCLUSIVE`; `clockResolution` never returns `0`.
* Prepare arguments: reject `--label` for a bootstrap baseline; reject a candidate without an `rc` label.
* Gate: a complete fixture with `reviewerKind: "automated"` gives `QUALIFIED-CANDIDATE`; `ownerApproval: true` gives `BLOCKED`; a newest regression run that is not `PASS` gives `BLOCKED`; removing any one required field gives `BLOCKED`; a bootstrap baseline with an existing `.release` tag gives `BLOCKED`; a regression `FAIL` gives `FAILED`; a waiver gives `BLOCKED`.
* Server: an unknown path and `..` give `404`; a matching ETag gives `304`; `deploy` changes the served hash.

These tests check logic only. They do not replace the browser exercise or the reference job.

## 14. Limits

* The reference profile is a GitHub-hosted virtual computer with software or virtual display rendering. It is not a user device.
* Desktop WebKit is not iOS Safari. Physical iOS and Android devices are **not tested**.
* Native platforms are **unqualified**.
* The first rollback target is a bootstrap reference, not a qualified release.
* Reproducibility is shown for one host and toolchain. Cross-host byte identity is not claimed.
* Timer resolution in some engines is coarse. The measured `resolution` term includes it in the limit. A coarse clock makes `INCONCLUSIVE` results more likely.
* Startup metrics do not measure the first visible pixel. The pixel checks in section 6.2 prove correctness, not latency.

## 15. Open questions for the owner

These questions do not block the candidate. They block a `.release` publication.

1. Approve the proposed label core `0.5.0` or select a different compatibility rule. The candidate can use the proposed core before this approval.
2. Decide the `Cargo.toml` version for a publication, and the product name under MADR 0006.
3. Decide whether a GitHub Release object is necessary for a publication.
4. Decide whether a physical device profile is necessary before a publication.

**Writing review:** STE-aligned draft. Full dictionary review not done.
