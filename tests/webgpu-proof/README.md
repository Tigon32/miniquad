# WebGPU proof harness

Writing review state: **STE-aligned draft**. Full dictionary review not done.

This harness tests both candidates of the
[WebGPU proof contract](../../docs/webgpu-proof-contract.md) with one oracle.
The queen or parent owns these files. Candidate workers do not edit them.

| File | Purpose |
| --- | --- |
| `contract.mjs` | Expected values and checks. It has no browser dependency |
| `instrumentation.mjs` | Init script that records contexts, adapters, devices, errors, and applies N1 to N4 |
| `run-proof.mjs` | Playwright runner for one candidate and one lane. It writes a receipt |
| `harness.test.mjs` | Unit tests for the oracle, instrumentation, runner arguments, and server |
| `../../scripts/webgpu-proof-serve.mjs` | Static server for `experiments/webgpu-<candidate>/dist/` |

## Commands

```sh
node --test tests/webgpu-proof/harness.test.mjs
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane software
node tests/webgpu-proof/run-proof.mjs --candidate wgpu --lane software
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane chromium-default
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane firefox-default
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane webkit-default
```

The runner needs the repository-pinned `@playwright/test` browsers and a built `dist/` folder.
The receipt records the pinned and installed Playwright versions and the browser version.
A receipt with `matchesPin: false` is not valid proof evidence.
It writes `target/webgpu-proof/<candidate>-<lane>-<browser>.json`.
It exits with code 1 if a case fails, if a case does not run, or if the lane has no result.
Set `WEBGPU_PROOF_STEP_TIMEOUT_MS` to change the deadline for each wait. The default is 20000.

## Rules

* Each wait polls the status on animation frames until a condition or a deadline.
  There is no fixed sleep. A deadline is a failure with the last status.
* An unexpected terminal phase stops the wait and fails the case.
* Every status read is checked for the contract shape and for progress rules.
* A rejection result is `rejection-pass`. It never counts as a rendering `pass`.
* The software lane fails if the adapter is not a fallback adapter.
* Observation lanes run the natural rejection only if the browser has no API or no adapter.
  If an adapter exists, they run T1 to T7 and record the adapter facts.
* T1 to T5 share one page. A failure marks the later cases in that page as failed, not as passed.
* Every receipt records hardware as **NOT TESTED**.

## Limits

The unit tests check the oracle and the instrumentation with fake browser objects.
They do not prove WebGPU behavior. Only a browser run against a built candidate can do that.
A software-adapter result does not qualify hardware or another OS.
