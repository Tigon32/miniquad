# Browser release candidate evidence — TEMPLATE

> Copy this file to a candidate-specific filename. Replace **every** `NOT RUN` or `UNKNOWN` field with verifiable evidence or an explicit blocker. Do not publish this template as a passing receipt.

## Identity

- Candidate tag: NOT ASSIGNED
- Exact source SHA: UNKNOWN
- Upstream base SHA: UNKNOWN
- Build date/time (UTC): NOT RUN
- Builder and OS: NOT RUN
- `rustc --version`: NOT RUN
- `cargo --version`: NOT RUN
- `node --version`: NOT RUN
- `npm --version`: NOT RUN
- Lockfile/dependency revision: NOT RUN
- Rust build command and flags: NOT RUN
- Browser JS build or copy command: NOT RUN

## Shipped artifacts

Run `bash scripts/measure-browser-artifacts.sh path/to/app.wasm path/to/gl.js` on the **shipped pair**. Attach the complete raw output. Keep JS and WASM from the same source revision.

| Artifact | SHA-256 | Raw bytes | gzip bytes | Brotli bytes |
| --- | --- | --- | --- | --- |
| WASM | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| gl.js | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

- Compression tool versions: NOT RUN
- Artifact retention location: NOT RUN
- Source revision matching evidence: NOT RUN

## Required checks

| Check | Result (PASS/FAIL/SKIP/NOT RUN) | Evidence link and SHA |
| --- | --- | --- |
| Cargo fmt | NOT RUN | |
| Clippy | NOT RUN | |
| Rust unit and contract tests | NOT RUN | |
| JavaScript lint and tests | NOT RUN | |
| WASM release-example build | NOT RUN | |
| Dependency, license and security review | NOT RUN | |
| JS/WASM ABI mismatch and import checks | NOT RUN | |
| Browser runtime acceptance | NOT RUN | |

A skipped, missing or pending required check is **not** a pass.

## Browser matrix

| Browser engine | Exact version | Host OS/device | First frame | Resize / DPR | Input / focus | WebGL context and offscreen target | Failure paths |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Firefox | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| WebKit | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical iOS Safari | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Android Chrome | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Record browser logs, CI links, screenshots or machine-readable reports. Desktop WebKit does not qualify physical iOS Safari.

## Performance baseline and candidate

- Fixed demo/fixture and input trace: NOT RUN
- Hardware, CPU/GPU, device RAM, network conditions: NOT RUN
- Cold and warm definitions; repetitions: NOT RUN
- Baseline commit and artifact hashes: NOT RUN
- Candidate commit and artifact hashes: NOT RUN
- First-frame latency (distribution): NOT RUN
- Frame interval p95/p99 and sample count: NOT RUN
- CPU, WASM heap, JS heap and GPU resources: NOT RUN
- Input-to-visible latency: NOT RUN
- Size difference, uncertainty, correctness parity: NOT RUN
- Budget source and calibration evidence: NOT RUN

Do not use provisional targets as measured results.

## Compatibility, limitations and rollback

- Public Rust/API and JS/WASM contract diff: NOT REVIEWED
- Change log and upstream patch provenance: NOT REVIEWED
- Applicable unresolved security findings: NOT REVIEWED
- Untested native/mobile platforms: NOT REVIEWED
- Prior qualified artifact pair and verified hashes: NOT RUN
- Rollback drill command, target and observed first frame: NOT RUN
- State migration or rollback incompatibility: NOT REVIEWED

## Gate decision

- Result: **BLOCKED — TEMPLATE ONLY**
- Reviewer: NOT ASSIGNED
- Review date: NOT ASSIGNED
- Required-check waivers (scope, owner, expiry, risk): NONE RECORDED
- Approval/reference: NOT APPROVED

See [release qualification policy](../release.md). Do not close [#19](https://github.com/Tigon32/miniquad/issues/19) without actual candidate and rollback evidence.
