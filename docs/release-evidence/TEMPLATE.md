# Browser release candidate evidence — TEMPLATE

> Copy this file to a candidate-specific filename. Replace **every** `NOT RUN` or `UNKNOWN` field with verifiable evidence or an explicit blocker. Do not publish this template as a passing receipt.

## Identity

- Candidate tag: NOT ASSIGNED
- Candidate artifact label / Cargo package version: NOT ASSIGNED / NOT REVIEWED
- Exact source SHA: UNKNOWN
- Candidate tool source SHA: UNKNOWN
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
- Baseline source, role, and reference kind: NOT RUN
- Previous qualified release or explicit bootstrap limitation: NOT REVIEWED

## Shipped artifacts

Run `bash scripts/measure-browser-artifacts.sh path/to/app.wasm path/to/gl.js` on the **shipped pair**. Attach the complete raw output. Keep JS and WASM from the same source revision.

| Artifact | SHA-256 | Raw bytes | gzip bytes | Brotli bytes |
| --- | --- | --- | --- | --- |
| WASM | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| gl.js | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

- Compression tool versions: NOT RUN
- Artifact retention location: NOT RUN
- Source revision matching evidence: NOT RUN
- Canonical manifest SHA-256 and complete payload inventory: NOT RUN
- Two fresh builds with identical payload bytes: NOT RUN
- Private-path and credential-pattern scan: NOT RUN
- Candidate, baseline, and tool input receipts: NOT RUN

## Required checks

| Check | Result (PASS/FAIL/SKIP/NOT RUN) | Evidence link and SHA |
| --- | --- | --- |
| Focused Rust format and separate legacy format audit | NOT RUN | |
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
- Manual reference-profile CI run and exact browser/tool versions: NOT RUN
- Alternating baseline/candidate pairs per engine (minimum 20): NOT RUN
- Measured positive clock resolution per engine: NOT RUN
- Raw samples, baseline p90, candidate median confidence bounds, and limits: NOT RUN
- Regression result (PASS/FAIL/INCONCLUSIVE) per gated metric: NOT RUN

Do not use provisional targets as measured results.

## Compatibility, limitations and rollback

- Public Rust/API and JS/WASM contract diff: NOT REVIEWED
- Change log and upstream patch provenance: NOT REVIEWED
- Applicable unresolved security findings: NOT REVIEWED
- Untested native/mobile platforms: NOT REVIEWED
- Prior qualified artifact pair and verified hashes: NOT RUN
- Rollback drill command, target and observed first frame: NOT RUN
- Baseline to candidate to exact baseline in all three engines: NOT RUN
- Served and browser-received hashes, visible pixels, screenshots, and errors: NOT RUN
- Existing candidate tab reloaded after rollback: NOT RUN
- State migration or rollback incompatibility: NOT REVIEWED

## Gate decision

- Result: **BLOCKED — TEMPLATE ONLY**
- Reviewer: NOT ASSIGNED
- Reviewer kind (person or automated agent): NOT ASSIGNED
- Review method and source-bound evidence references: NOT RUN
- Review date: NOT ASSIGNED
- Required-check waivers (scope, owner, expiry, risk): NONE RECORDED
- Approval/reference: NOT APPROVED
- Human owner publication approval: **false — not granted by candidate qualification**

See [release qualification policy](../release.md). Do not close [#19](https://github.com/Tigon32/miniquad/issues/19) without actual candidate and rollback evidence.
Use [the candidate contract](../release-candidate-contract.md) for machine-readable evidence.
A waiver or inconclusive mandatory result gives `BLOCKED`, not `QUALIFIED-CANDIDATE`.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
